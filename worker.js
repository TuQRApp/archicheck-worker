import { buildReglasAprendidasSystem } from "./reglas_aprendidas.js";

export default {
  async fetch(request, env) {

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Metodo no permitido" }), {
        status: 405,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const CORS = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    };
    const CORS_JSON = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };

    try {
      const body  = await request.json();
      const modelo = body.modelo || "claude";

      // ── Reglas aprendidas: siempre, sin depender de ragQuery ───────────────
      // Estas reglas vienen de ground truth validado por arquitectos (ver
      // reglas_aprendidas.js) y deben llegar tanto al análisis geométrico/
      // semántico del notebook (Celda 4) como al análisis normativo del dossier —
      // ambos pasan por este mismo worker, ninguno envía ragQuery necesariamente.
      let normativaSystem = buildReglasAprendidasSystem();

      // ── RAG: recuperar normativa relevante ────────────────────────────────
      // RAG solo si el frontend envía ragQuery explícito.
      // No usar el mensaje del usuario como fallback: cuando el payload contiene imágenes
      // el "user content" es el buildPrompt instructivo (>4 KB), no una query semántica,
      // y el system RAG degrada el análisis estructurado.
      if (body.ragQuery && env.SUPABASE_URL && env.SUPABASE_KEY && env.OPENAI_API_KEY) {
        try {
          const chunks = await queryNormativa(body.ragQuery, env, 25);
          const normativaBlock = buildNormativaSystem(chunks);
          if (normativaBlock) {
            normativaSystem = normativaSystem
              ? `${normativaSystem}\n\n---\n\n${normativaBlock}`
              : normativaBlock;
          }
        } catch (ragErr) {
          console.error("RAG error:", ragErr.message);
        }
      }

      // ── GPT-4o ────────────────────────────────────────────────────────────
      if (modelo === "gpt4o") {
        if (!env.OPENAI_API_KEY) {
          return new Response(JSON.stringify({ error: "OPENAI_API_KEY no configurada" }), {
            status: 500, headers: CORS_JSON,
          });
        }

        const openaiMessages = [];
        if (normativaSystem) {
          openaiMessages.push({ role: "system", content: normativaSystem });
        }
        openaiMessages.push(
          ...(body.messages || []).map(msg => ({
            role: msg.role,
            content: Array.isArray(msg.content)
              ? msg.content.map(item => {
                  if (item.type === "image") {
                    return {
                      type: "image_url",
                      image_url: {
                        url: `data:${item.source.media_type};base64,${item.source.data}`,
                        detail: "high",
                      },
                    };
                  }
                  return { type: "text", text: item.text };
                })
              : msg.content,
          }))
        );

        const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o",
            max_tokens: 32000,
            stream: true,
            messages: openaiMessages,
          }),
        });

        if (!openaiResp.ok) {
          const errText = await openaiResp.text();
          return new Response(JSON.stringify({ error: errText }), {
            status: 500, headers: CORS_JSON,
          });
        }

        const { readable, writable } = new TransformStream();
        const writer  = writable.getWriter();
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        (async () => {
          const reader = openaiResp.body.getReader();
          let buffer = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === "data: [DONE]") continue;
                if (!trimmed.startsWith("data: ")) continue;
                try {
                  const evt  = JSON.parse(trimmed.slice(6));
                  const text = evt.choices?.[0]?.delta?.content;
                  if (text) {
                    const normalized = `data: ${JSON.stringify({
                      type: "content_block_delta",
                      delta: { type: "text_delta", text },
                    })}\n\n`;
                    await writer.write(encoder.encode(normalized));
                  }
                } catch (_) { /* chunk parcial */ }
              }
            }
          } finally {
            writer.close();
          }
        })();

        return new Response(readable, { headers: CORS });
      }

      // ── Claude (default) ──────────────────────────────────────────────────
      if (!env.ANTHROPIC_API_KEY) {
        return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY no configurada" }), {
          status: 500, headers: CORS_JSON,
        });
      }

      const claudeBody = {
        model: "claude-sonnet-4-6",
        max_tokens: 32000,
        stream: true,
        messages: body.messages,
      };
      if (normativaSystem) {
        claudeBody.system = normativaSystem;
      }

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(claudeBody),
      });

      if (!response.ok) {
        const errText = await response.text();
        return new Response(JSON.stringify({ error: errText }), {
          status: 500, headers: CORS_JSON,
        });
      }

      return new Response(response.body, { headers: CORS });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  },
};

// ── RAG helpers ───────────────────────────────────────────────────────────────

/** Extrae texto del último mensaje del usuario para usar como query RAG */
function extractQueryText(messages) {
  if (!messages) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content.substring(0, 2000);
    if (Array.isArray(msg.content)) {
      const textItem = msg.content.find(c => c.type === "text");
      if (textItem?.text) return textItem.text.substring(0, 2000);
    }
  }
  return "";
}

/** Genera embedding y consulta Supabase match_normativa */
async function queryNormativa(queryText, env, count = 25) {
  const supaHdr = {
    "apikey":        env.SUPABASE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_KEY}`,
    "Content-Type":  "application/json",
  };

  // Embedding
  const embResp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: queryText }),
  });
  if (!embResp.ok) throw new Error(`OpenAI embedding ${embResp.status}`);
  const embedding = (await embResp.json()).data[0].embedding;

  // Búsqueda semántica principal
  const supaResp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_normativa`, {
    method: "POST",
    headers: supaHdr,
    body: JSON.stringify({ query_embedding: embedding, match_count: count }),
  });
  if (!supaResp.ok) throw new Error(`Supabase ${supaResp.status}: ${await supaResp.text()}`);
  const chunks = await supaResp.json();

  // Fallback PRC-PRV: si el resultado principal no trajo zonas PRC, buscar directamente
  // (el índice IVFFlat puede desviar la búsqueda lejos de las zonas PRC)
  const hasPRC = Array.isArray(chunks) && chunks.some(c => c.fuente === "PRC-PRV");
  if (!hasPRC && env.SUPABASE_URL) {
    try {
      const prcResp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_normativa`, {
        method: "POST",
        headers: supaHdr,
        body: JSON.stringify({ query_embedding: embedding, match_count: 8, fuentes: ["PRC-PRV"] }),
      });
      if (prcResp.ok) {
        const prcChunks = await prcResp.json();
        if (Array.isArray(prcChunks) && prcChunks.length > 0) {
          return [...(Array.isArray(chunks) ? chunks : []), ...prcChunks];
        }
      }
    } catch (_) { /* PRC fallback no es crítico */ }
  }

  return chunks;
}

/** Construye el bloque de normativa para el system prompt */
function buildNormativaSystem(chunks) {
  if (!chunks || chunks.length === 0) return "";

  const articulos = chunks
    .filter(c => c.similarity > 0.45)
    .map(c => {
      // DDU: "DDU-172-s3" → citar como "[DDU 172]" (número de circular, no sección interna)
      let ref;
      if (c.fuente === "DDU") {
        const m = c.codigo?.match(/^DDU-(\d+)-/);
        ref = m ? `[DDU ${m[1]}]` : `[${c.codigo}]`;
      } else {
        ref = c.codigo ? `[${c.codigo}]` : "";
      }
      const tit = c.titulo ? ` ${c.titulo}` : "";
      return `${ref}${tit}\n${c.texto}`;
    })
    .join("\n\n---\n\n");

  if (!articulos) return "";

  return `INSTRUCCIÓN: La siguiente normativa oficial fue recuperada por ArchiCheck. \
Cuando respondas, cita preferentemente estos artículos usando sus códigos exactos entre corchetes. \
Para DDU usa espacio: [DDU 447] no [DDU-447]. No añadas disclaimers sobre acceso o vigencia.

NORMATIVA RECUPERADA:

${articulos}`;
}
