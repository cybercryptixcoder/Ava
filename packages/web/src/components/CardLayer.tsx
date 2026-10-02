import { useCallback, useEffect, useState } from "react";
import type { CardLayer2, CardLayer3, CardResponse, CardView, HydratedItem, StackView } from "@ava/shared";
import { api } from "../lib/api";
import { setData } from "../lib/store";
import { when } from "../lib/time";
import { Button, ErrorLine, Sheet } from "./ui";
import { Shadow } from "./Shadow";
import { ArtifactView } from "./ArtifactView";

/**
 * Layers 2 and 3 of a card, built lazily from current state the first time
 * they are opened. Layer 2: the thread's few relevant parts, the options in
 * detail, or what was filed. Layer 3: the work itself or the full detail.
 */
export function LayerSheet({
  card,
  onClose,
  onRespond,
  onOpenAction,
}: {
  card: CardView;
  onClose: () => void;
  onRespond: (card: CardView, response: CardResponse, option?: string | null) => Promise<void>;
  onOpenAction: (actionId: string) => void;
}) {
  const [layer, setLayer] = useState<2 | 3>(2);
  const [two, setTwo] = useState<CardLayer2 | null>(null);
  const [three, setThree] = useState<CardLayer3 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadTwo = useCallback(async () => {
    try {
      setTwo(await api.get<CardLayer2>(`/api/cards/${card.id}/layer/2`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [card.id]);
  useEffect(() => {
    setLayer(2);
    setThree(null);
    void loadTwo();
  }, [card.id, loadTwo]);

  const deeper = async () => {
    try {
      if (!three) setThree(await api.get<CardLayer3>(`/api/cards/${card.id}/layer/3`));
      setLayer(3);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const undo = async (proposalId: string) => {
    setBusy(true);
    try {
      const r = await api.post<{ stack: StackView }>(`/api/filings/${proposalId}/undo`);
      setData<StackView>("/api/stack", () => r.stack);
      await loadTwo();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const respond = async (response: CardResponse, option?: string | null) => {
    setBusy(true);
    try {
      await onRespond(card, response, option);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onClose={onClose} title={card.title} wide>
      {error ? <ErrorLine error={error} /> : null}
      {layer === 2 ? (
        <>
          {two?.paragraphs.map((p, i) => (
            <p key={i} className="layer-para voice-sm">
              {p}
            </p>
          ))}
          {two?.parts.length ? (
            <ul className="layer-parts">
              {two.parts.map((i) => (
                <PartRow key={i.id} item={i} />
              ))}
            </ul>
          ) : null}
          {two?.filed.length ? (
            <ul className="layer-filed">
              {two.filed.map((f) => (
                <li key={f.proposal_id} className="layer-filed-row" data-status={f.status}>
                  <span className="layer-filed-main">{f.summary}</span>
                  {f.status === "filed" ? (
                    <Button size="sm" kind="quiet" busy={busy} onClick={() => void undo(f.proposal_id)}>
                      Undo
                    </Button>
                  ) : (
                    <span className="layer-filed-state">{f.status === "undone" ? "Undone" : "Needs you"}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {two?.options.length && card.kind !== "know" ? (
            <ul className="card-options layer-options" aria-label="Choices">
              {two.options.map((o) => (
                <li key={o.key}>
                  <button type="button" className="card-option" disabled={busy} onClick={() => void respond("yes", o.key)}>
                    <span className="card-option-label">{o.label}</span>
                    {o.detail ? <span className="card-option-detail">{o.detail}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {two?.shadow ? <Shadow shadow={two.shadow} /> : null}
          <div className="layer-actions">
            {card.deeper ? (
              <Button kind="primary" size="sm" disabled={busy} onClick={() => void deeper()}>
                Full detail
              </Button>
            ) : null}
            {card.has_items ? (
              <Button kind="quiet" size="sm" busy={busy} onClick={() => void respond("already_done")}>
                Already done
              </Button>
            ) : null}
            <Button kind="quiet" size="sm" busy={busy} onClick={() => void respond("stop")}>
              Stop suggesting this
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="layer-actions">
            <Button kind="quiet" size="sm" onClick={() => setLayer(2)}>
              Back
            </Button>
          </div>
          {three?.artifact ? <ArtifactView artifact={three.artifact} moduleKey={`card-${card.id}`} /> : null}
          {three?.action ? (
            <div className="layer-action">
              <p className="layer-para">
                <span className="label">To</span> {three.action.preview.to}
              </p>
              <p className="layer-para">
                <span className="label">Subject</span> {three.action.preview.subject}
              </p>
              <pre className="draft-body">{three.action.preview.body}</pre>
              <div className="row-actions">
                <Button
                  kind="primary"
                  size="sm"
                  onClick={() => {
                    onOpenAction(three.action!.id);
                    onClose();
                  }}
                >
                  Review and send
                </Button>
              </div>
            </div>
          ) : null}
          {three?.rule ? (
            <div className="layer-rule">
              <p className="voice-sm">{three.rule.sentence}</p>
              {three.rule.evidence ? (
                <p className="layer-para">
                  <span className="label">Based on</span> {three.rule.evidence}
                </p>
              ) : null}
            </div>
          ) : null}
          {three?.paragraphs.map((p, i) => (
            <p key={i} className="layer-para voice-sm">
              {p}
            </p>
          ))}
          {three?.items.length ? (
            <ul className="layer-parts">
              {three.items.map((i) => (
                <PartRow key={i.id} item={i} />
              ))}
            </ul>
          ) : null}
        </>
      )}
    </Sheet>
  );
}

function PartRow({ item }: { item: HydratedItem }) {
  const done = ["done", "dropped", "closed", "achieved"].includes(item.status);
  return (
    <li className="layer-part" data-done={done || undefined}>
      <span className="layer-part-title">{item.title}</span>
      <span className="layer-part-meta">
        <span>{item.status_label}</span>
        {item.due_at ? <span className="num">{when(item.due_at)}</span> : null}
      </span>
    </li>
  );
}
