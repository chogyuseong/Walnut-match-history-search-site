import type { Draft } from "../../../shared/draft";
import type { Snapshot } from "../../../shared/types";
import { drawDraftImage, fileDate, ShareImageDialog } from "../../shareImage";

/** 편성 이미지 창: 블루팀·레드팀 명단 PNG(공유·내려받기). 티어·서포터 횟수 등 비공개 정보는 넣지 않는다. */
export function DraftImageDialog(props: { draft: Draft; snapshot: Snapshot | null; onClose: () => void }) {
  const { draft, snapshot } = props;
  const timezone = snapshot?.group.timezone ?? "Asia/Seoul";
  return (
    <ShareImageDialog
      title="편성 이미지"
      fileName={`편성-${fileDate(new Date().toISOString(), timezone)}.png`}
      make={() => drawDraftImage(draft, snapshot?.group.name ?? "내전", timezone)}
      onClose={props.onClose}
    />
  );
}
