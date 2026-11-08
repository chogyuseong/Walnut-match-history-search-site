-- 2026-11-07 서버·운영 개선(docs/개선-서버-2026-11-07.md).
--
-- 1) groups.data_version: 모임의 화면 자료(참가자·경기·시즌·시리즈·신청 등)가 바뀔 때마다 오르는 값.
--    조회·운영자 스냅숏의 ETag(src/server/snapshot.ts snapshotEtag)가 이 값으로 "바뀌지 않았음(304)"을 판단한다.
--    코드 경로마다 올리게 하면 빠뜨리기 쉬워(쓰기 경로가 여러 파일에 70곳 넘게 있다) 아래 트리거가 올린다.
--    - 경기 명단(match_roster)·변경 이력(match_revisions)에는 트리거를 두지 않는다: 이 두 표는 늘 같은 batch에서
--      matches 행(버전) 또는 participant_merges 행과 함께 바뀌므로 그쪽 트리거가 대신 올린다. 큰 가져오기·복원에서
--      트리거가 쓰는 행 수(D1 쓰기 한도에 들어감)를 줄이려는 것이다.
--    - settings_versions에도 두지 않는다: 설정 저장은 groups.settings_version_id를 바꾸고, ETag가 그 값을 직접 본다.
--    - 주의: 나중에 위 표를 "새 표 만들기 → 복사 → 이름 바꾸기"로 바꾸는 마이그레이션은 트리거가 함께 사라지므로
--      같은 마이그레이션에서 트리거를 다시 만들어야 한다.
-- 2) groups.backup_tried_at / backup_done_at: 자동 백업(src/server/backupCron.ts)의 진행 표시.
-- 3) participants.version: 참가자 수정의 동시 수정 확인(src/server/groups.ts updateParticipant). 참가자 행을 바꾸는
--    코드는 모두 version = version + 1을 함께 쓴다(groups.ts, merge.ts, members.ts).
-- 4) guard.group_limit: 계정당 모임 수 한도를 batch 안에서 다시 확인하는 보호 문장(src/server/groups.ts groupLimitGuard).

ALTER TABLE groups ADD COLUMN data_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN backup_tried_at TEXT;
ALTER TABLE groups ADD COLUMN backup_done_at TEXT;
ALTER TABLE participants ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guard ADD COLUMN group_limit INTEGER CONSTRAINT guard_group_limit CHECK (group_limit IS NULL);

CREATE INDEX idx_groups_backup ON groups (backup_done_at, backup_tried_at);

-- participants
CREATE TRIGGER trg_dv_participants_ins AFTER INSERT ON participants BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_participants_upd AFTER UPDATE ON participants BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_participants_del AFTER DELETE ON participants BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;

-- matches
CREATE TRIGGER trg_dv_matches_ins AFTER INSERT ON matches BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_matches_upd AFTER UPDATE ON matches BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_matches_del AFTER DELETE ON matches BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;

-- sessions
CREATE TRIGGER trg_dv_sessions_ins AFTER INSERT ON sessions BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_sessions_upd AFTER UPDATE ON sessions BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_sessions_del AFTER DELETE ON sessions BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;

-- rotation_cycles
CREATE TRIGGER trg_dv_rotation_cycles_ins AFTER INSERT ON rotation_cycles BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_rotation_cycles_upd AFTER UPDATE ON rotation_cycles BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_rotation_cycles_del AFTER DELETE ON rotation_cycles BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;

-- rotation_events
CREATE TRIGGER trg_dv_rotation_events_ins AFTER INSERT ON rotation_events BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_rotation_events_upd AFTER UPDATE ON rotation_events BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_rotation_events_del AFTER DELETE ON rotation_events BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;

-- seasons
CREATE TRIGGER trg_dv_seasons_ins AFTER INSERT ON seasons BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_seasons_upd AFTER UPDATE ON seasons BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_seasons_del AFTER DELETE ON seasons BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;

-- match_series
CREATE TRIGGER trg_dv_match_series_ins AFTER INSERT ON match_series BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_match_series_upd AFTER UPDATE ON match_series BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_match_series_del AFTER DELETE ON match_series BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;

-- match_series_members
CREATE TRIGGER trg_dv_match_series_members_ins AFTER INSERT ON match_series_members BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_match_series_members_upd AFTER UPDATE ON match_series_members BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_match_series_members_del AFTER DELETE ON match_series_members BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;

-- support_adjustments
CREATE TRIGGER trg_dv_support_adjustments_ins AFTER INSERT ON support_adjustments BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_support_adjustments_upd AFTER UPDATE ON support_adjustments BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_support_adjustments_del AFTER DELETE ON support_adjustments BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;

-- participant_merges
CREATE TRIGGER trg_dv_participant_merges_ins AFTER INSERT ON participant_merges BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_participant_merges_upd AFTER UPDATE ON participant_merges BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_participant_merges_del AFTER DELETE ON participant_merges BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;

-- participant_links
CREATE TRIGGER trg_dv_participant_links_ins AFTER INSERT ON participant_links BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_participant_links_upd AFTER UPDATE ON participant_links BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_participant_links_del AFTER DELETE ON participant_links BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;

-- participant_claims
CREATE TRIGGER trg_dv_participant_claims_ins AFTER INSERT ON participant_claims BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_participant_claims_upd AFTER UPDATE ON participant_claims BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_participant_claims_del AFTER DELETE ON participant_claims BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;

-- participant_requests
CREATE TRIGGER trg_dv_participant_requests_ins AFTER INSERT ON participant_requests BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_participant_requests_upd AFTER UPDATE ON participant_requests BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_participant_requests_del AFTER DELETE ON participant_requests BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;

-- import_batches
CREATE TRIGGER trg_dv_import_batches_ins AFTER INSERT ON import_batches BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_import_batches_upd AFTER UPDATE ON import_batches BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_import_batches_del AFTER DELETE ON import_batches BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;

-- join_links
CREATE TRIGGER trg_dv_join_links_ins AFTER INSERT ON join_links BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_join_links_upd AFTER UPDATE ON join_links BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_join_links_del AFTER DELETE ON join_links BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;

-- join_requests
CREATE TRIGGER trg_dv_join_requests_ins AFTER INSERT ON join_requests BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_join_requests_upd AFTER UPDATE ON join_requests BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = NEW.group_id;
END;
CREATE TRIGGER trg_dv_join_requests_del AFTER DELETE ON join_requests BEGIN
  UPDATE groups SET data_version = data_version + 1 WHERE id = OLD.group_id;
END;
