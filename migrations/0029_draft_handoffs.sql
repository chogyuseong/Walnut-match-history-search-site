-- 편성 넘기기(2026-11-18). 편성 초안은 원래 기기에만 있다(src/shared/draft.ts). PC에서 짜다 휴대폰으로 옮기거나
-- 공동 운영자에게 맡길 때 끊기지 않게, 모임마다 "넘긴 편성" 한 칸을 서버에 둔다. 다른 기기가 이어받으면 지운다.
--
-- - 모임당 한 행(group_id가 열쇠). 새로 넘기면 덮어쓴다. 실시간 공동 편집이 아니라 "한 번 건네기"다.
-- - body: 화면이 보낸 JSON 그대로({ draft, nightPool? }). 서버는 크기와 겉모양만 보고(src/server/draftHandoff.ts),
--   받는 기기가 기기 저장값과 같은 검사(parseStoredDraft)를 다시 한다. 서버가 편성을 해석하지 않으므로 초안 형식이
--   바뀌어도 이 표는 그대로 둔다.
-- - handoff_id: 넘긴 기기가 만든 무작위 ID. 넘긴 기기는 자기가 넘긴 것인지 이 값으로 알아본다(계정 ID는 화면에 주지 않는다).
-- - base_live_version·people: 운영자 스냅숏에 본문 없이 싣는 요약(몇 명, 어느 진행 상태에서 짰는지).
-- - 경기를 시작하면 지운다(src/server/matches.ts). 그 뒤의 넘긴 편성은 이미 지난 상태라서다.
-- - 스냅숏은 시각으로 거르지 않는다: 시각에 따라 내용이 바뀌면 ETag 재료를 늘려야 한다(snapshot.ts snapshotEtag).
--   화면이 넘긴 지 12시간 지난 것은 보여 주지 않고, 새벽 예정 작업이 24시간 지난 행을 지운다(draftHandoff.ts pruneDraftHandoffs).
-- - 백업에 넣지 않는다. 복원·모임 삭제는 비운다(restore.ts GROUP_DATA_TABLES).

CREATE TABLE draft_handoffs (
  group_id TEXT PRIMARY KEY REFERENCES groups(id),
  handoff_id TEXT NOT NULL,
  body TEXT NOT NULL,
  base_live_version INTEGER,
  people INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- 운영자 스냅숏에 실리므로 바뀌면 data_version을 올린다(migrations/0021 머리말: 스냅숏에 새 표를 실으면 트리거도 만든다).
CREATE TRIGGER trg_dv_draft_handoffs_ins AFTER INSERT ON draft_handoffs BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_draft_handoffs_upd AFTER UPDATE ON draft_handoffs BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_draft_handoffs_del AFTER DELETE ON draft_handoffs BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;
