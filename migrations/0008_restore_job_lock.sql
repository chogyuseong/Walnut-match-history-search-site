-- 여러 단계 복원·삭제의 잠금(검토 M2). 확장만 한다(열 추가). 이전 앱 버전도 이 스키마에서 그대로 동작한다.
--
-- 지금까지 restore_jobs는 "작업 행이 있다"만 뜻해서, 같은 모임에서 두 복원이 동시에 돌거나
-- 시간 초과 뒤 다시 보낸 요청이 앞 실행과 겹치면 늦은 단계가 다른 복원이 끝난 뒤에 행을 넣을 수 있었다.
-- 이제 작업 행이 "누가 지금 이 작업을 하는지"를 적는다(src/server/restore.ts, src/server/deletion.ts):
--   request_id  : 작업을 시작한 요청 ID(안내용). 모임 삭제는 'delete'.
--   run_token   : 실행 한 번마다 새로 만드는 값. 모든 단계의 batch가 맨 앞에서 "작업 행의 run_token = 나"를
--                 확인하고, 아니면 guard_job_busy로 batch 전체를 되돌린다. NULL이면 주인이 없다(실패를 알고 놓음, 또는 이전 버전의 행).
--   heartbeat_ms: 마지막 단계가 끝난 시각(유닉스 밀리초). 주인이 있어도 이 값이 오래되면(실행이 죽음) 다른 실행이 이어받는다.
ALTER TABLE restore_jobs ADD COLUMN request_id TEXT;
ALTER TABLE restore_jobs ADD COLUMN run_token TEXT;
ALTER TABLE restore_jobs ADD COLUMN heartbeat_ms INTEGER NOT NULL DEFAULT 0;

-- 작업 행의 주인이 내가 아니면 값을 넣어 batch를 실패시키는 보호 열.
ALTER TABLE guard ADD COLUMN job_busy INTEGER CONSTRAINT guard_job_busy CHECK (job_busy IS NULL);
