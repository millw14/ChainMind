/**
 * Server-Sent Events, read defensively.
 *
 * Groq is OpenAI-compatible, so a `stream: true` completion comes back as a
 * byte stream of text frames: `data: {json}\n\n`, repeated, ending with
 * `data: [DONE]`. Nothing about that is guaranteed to arrive tidily. A network
 * chunk boundary can land in the middle of a line, in the middle of a JSON
 * object, or between the two newlines that end a frame; proxies inject comment
 * keep-alives (`: ping`) to hold the connection open; some send `event:` and
 * `id:` fields we have no use for; and one malformed frame must not be allowed
 * to abort an answer that is otherwise arriving correctly.
 *
 * So the parser is incremental and forgiving by construction:
 *
 *  - a partial line stays in the buffer until its newline arrives, so JSON is
 *    only ever parsed once it is whole;
 *  - blank lines, comment lines and non-`data` fields are skipped;
 *  - a `data:` payload that will not JSON.parse is COUNTED and dropped, never
 *    thrown — the alternative is losing the rest of a good answer to one bad
 *    frame;
 *  - `[DONE]` latches the parser closed, so anything a chatty upstream sends
 *    after the terminator cannot append itself to the answer.
 *
 * This module is a LEAF: it imports nothing, knows nothing about Groq's payload
 * shapes beyond `choices[0].delta.content`, and can be unit-tested with plain
 * strings. It is also ISOMORPHIC — no React, no Node builtins — which is why the
 * browser reads /api/ask's own SSE frames with the same `createSseParser` the
 * route uses on Groq's: one parser, one set of edge cases, tested once.
 */

/** The payload that terminates an OpenAI-compatible stream. */
export const SSE_DONE = "[DONE]";

/**
 * An incremental SSE reader.
 *
 * `push(chunk)` returns the events that became complete with this chunk, in
 * order — zero of them is the normal case for a chunk that ended mid-line.
 * `flush()` drains a final line that arrived without its newline, which is what
 * an upstream that closes the socket one byte early leaves behind.
 *
 * @returns {{ push(chunk: unknown): object[], flush(): object[], readonly done: boolean, readonly malformed: number }}
 */
export function createSseParser() {
  let buffer = "";
  let done = false;
  let malformed = 0;

  /** Read one complete line; push its payload onto `out` if it carries one. */
  function readLine(line, out) {
    // CR is stripped rather than split on: some proxies terminate with CRLF, and
    // a trailing \r inside a JSON payload makes JSON.parse fail for no reason.
    const text = line.replace(/\r+$/, "");
    if (!text) return; // frame separator
    if (text.startsWith(":")) return; // comment / keep-alive
    const colon = text.indexOf(":");
    // `event:`, `id:` and `retry:` are protocol, not payload. A line with no
    // colon at all is not a field either, so it is ignored the same way.
    if (colon === -1 || text.slice(0, colon) !== "data") return;
    // Exactly one optional space after the colon is part of the framing.
    let data = text.slice(colon + 1);
    if (data.startsWith(" ")) data = data.slice(1);
    if (!data) return;
    if (data === SSE_DONE) {
      done = true;
      return;
    }
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {
      // One unreadable frame is a dropped token, not a failed answer.
      malformed += 1;
    }
  }

  return {
    get done() {
      return done;
    },
    get malformed() {
      return malformed;
    },
    /**
     * @param {unknown} chunk - decoded text, any length, may split a line
     * @returns {object[]}
     */
    push(chunk) {
      const out = [];
      if (done) return out;
      buffer += typeof chunk === "string" ? chunk : String(chunk ?? "");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        readLine(line, out);
        if (done) {
          // Nothing after the terminator belongs to this answer.
          buffer = "";
          break;
        }
      }
      return out;
    },
    /** @returns {object[]} */
    flush() {
      const rest = buffer;
      buffer = "";
      const out = [];
      if (!done && rest) readLine(rest, out);
      return out;
    },
  };
}

/** Message content as text; an array of content parts is joined, not dropped. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

/**
 * The text this frame adds to the answer.
 *
 * Streaming frames carry `choices[0].delta.content`. The `message` fallback is
 * for the frame shape a non-streaming proxy sometimes emits instead, and it is
 * only read when there is NO `delta` key at all — reading both would append the
 * whole answer a second time to a stream that had already delivered it.
 *
 * Frames with no content — the role-only opener, the finish_reason closer, a
 * tool-call fragment — yield "" and add nothing.
 *
 * @param {unknown} event
 * @returns {string}
 */
export function deltaText(event) {
  if (!event || typeof event !== "object") return "";
  const choice = Array.isArray(event.choices) ? event.choices[0] : null;
  if (!choice || typeof choice !== "object") return "";
  if (choice.delta && typeof choice.delta === "object") return contentText(choice.delta.content);
  return contentText(choice.message?.content);
}

/**
 * The upstream's own error, when it is reported inside the stream rather than as
 * an HTTP status — a rate limit hit after the first frame arrives this way.
 *
 * @param {unknown} event
 * @returns {string|null}
 */
export function eventError(event) {
  const err = event && typeof event === "object" ? event.error : null;
  if (!err) return null;
  if (typeof err === "string") return err.slice(0, 300);
  const message = typeof err?.message === "string" ? err.message : "the upstream reported an error mid-stream";
  return String(message).slice(0, 300);
}
