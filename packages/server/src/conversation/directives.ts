/**
 * Streaming parser for Ava's reply format: plain words interleaved with
 * canvas directives. Text is passed through as it arrives; a directive is
 * emitted once its closing tag has streamed in.
 */
export type Directive =
  | { kind: "show"; body: string }
  | { kind: "update"; key: string; body: string }
  | { kind: "remove"; key: string }
  | { kind: "propose"; body: string }
  | { kind: "style_note"; body: string };

const OPEN = /<(show|update|remove|propose|style_note)(\s+key="([^"]*)")?\s*(\/)?>/;
const TAGS = ["show", "update", "remove", "propose", "style_note"];

export class DirectiveParser {
  private buf = "";
  /** Raw text including cue tokens, but without directives. */
  text = "";
  readonly directives: Directive[] = [];

  constructor(
    private onText: (t: string) => void,
    private onDirective: (d: Directive) => void,
  ) {}

  push(chunk: string): void {
    this.buf += chunk;
    this.drain(false);
  }

  end(): void {
    this.drain(true);
    if (this.buf) {
      this.emitText(this.buf);
      this.buf = "";
    }
  }

  private emitText(t: string) {
    if (!t) return;
    this.text += t;
    this.onText(t);
  }

  private drain(final: boolean): void {
    for (;;) {
      const lt = this.buf.indexOf("<");
      if (lt === -1) {
        this.emitText(this.buf);
        this.buf = "";
        return;
      }
      if (lt > 0) {
        this.emitText(this.buf.slice(0, lt));
        this.buf = this.buf.slice(lt);
      }
      const m = OPEN.exec(this.buf);
      if (!m || m.index !== 0) {
        // Could be the start of a tag that hasn't fully arrived.
        const partial = this.buf.slice(1, 12);
        const maybe = TAGS.some((t) => t.startsWith(partial.replace(/[\s/>].*$/, "")) && partial.length < t.length + 8);
        const closed = this.buf.includes(">");
        if (!final && maybe && !closed) return;
        this.emitText("<");
        this.buf = this.buf.slice(1);
        continue;
      }
      const tag = m[1];
      const key = m[3] ?? "";
      if (m[4] === "/" || tag === "remove") {
        this.buf = this.buf.slice(m[0].length);
        if (tag === "remove") this.fire({ kind: "remove", key });
        continue;
      }
      const close = `</${tag}>`;
      const end = this.buf.indexOf(close, m[0].length);
      if (end === -1) {
        if (final) {
          // Unterminated directive: drop it rather than speak JSON aloud.
          this.buf = "";
        }
        return;
      }
      const body = this.buf.slice(m[0].length, end).trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
      this.buf = this.buf.slice(end + close.length);
      if (tag === "show") this.fire({ kind: "show", body });
      else if (tag === "update") this.fire({ kind: "update", key, body });
      else if (tag === "propose") this.fire({ kind: "propose", body });
      else if (tag === "style_note") this.fire({ kind: "style_note", body });
    }
  }

  private fire(d: Directive) {
    this.directives.push(d);
    this.onDirective(d);
  }
}

/** Non-streaming convenience. */
export function parseReply(raw: string): { text: string; directives: Directive[] } {
  const p = new DirectiveParser(
    () => {},
    () => {},
  );
  p.push(raw);
  p.end();
  return { text: p.text, directives: p.directives };
}
