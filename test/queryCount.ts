import { env } from "cloudflare:test";
import type { Env } from "../src/server/env";
import { direct } from "./direct";
import type { ApiResult } from "./helpers";

/**
 * D1 질의 수 세기(2026-11-08 정합성 점검). Workers 무료 요금제는 호출(요청) 1회당 D1 질의 50회까지이고,
 * db.batch()는 문장 수와 상관없이 1회로 센다. 서버를 direct()로 부르면서 env.DB를 이 Proxy로 바꿔 끼우면
 * 그 요청 한 번이 D1을 몇 번 불렀는지 알 수 있다(인증·요청 수 제한·요청 ID 기록 등 같은 호출 안의 모든 질의 포함).
 *
 * 세는 것: 준비한 문장의 first·all·run·raw, batch, exec. bind는 새 문장을 돌려주므로 그것도 감싼다.
 * beforeBatch: batch 직전에 부른다(그 batch에 든 문장의 SQL 목록을 준다). "확인 뒤 batch 전에 상태가 바뀜"을 만들 때 쓴다.
 */
export const FREE_PLAN_QUERY_LIMIT = 50;

type Hook = (sqls: string[]) => void | Promise<void>;

interface Tagged {
  __sql?: string;
}

export interface CountingDb {
  db: D1Database;
  /** 지금까지 센 질의 수. */
  count(): number;
  reset(): void;
}

export function countingDb(db: D1Database = env.DB, hooks: { beforeBatch?: Hook } = {}): CountingDb {
  let n = 0;
  const patch = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    // 메서드를 바꿔 끼우려고 느슨한 모양으로 다룬다(D1 타입의 오버로드는 그대로 대입할 수 없다).
    (statement as unknown as Tagged).__sql = sql;
    const s = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const method of ["first", "all", "run", "raw"]) {
      const original = s[method]!.bind(statement);
      s[method] = (...args: unknown[]) => {
        n += 1;
        return original(...args);
      };
    }
    const bind = s.bind!.bind(statement);
    s.bind = (...values: unknown[]) => patch(bind(...values) as D1PreparedStatement, sql);
    return statement;
  };
  const proxy = {
    prepare: (sql: string) => patch(db.prepare(sql), sql),
    batch: async (statements: D1PreparedStatement[]) => {
      n += 1;
      if (hooks.beforeBatch) await hooks.beforeBatch(statements.map((s) => (s as Tagged).__sql ?? ""));
      return db.batch(statements);
    },
    exec: (sql: string) => {
      n += 1;
      return db.exec(sql);
    },
    dump: () => db.dump(),
    withSession: () => {
      throw new Error("countingDb: withSession은 세지 않는다");
    },
  };
  return {
    db: proxy as unknown as D1Database,
    count: () => n,
    reset: () => {
      n = 0;
    },
  };
}

/** 서버를 직접 불러 응답과 그 호출의 D1 질의 수를 함께 돌려준다. */
export async function directCounted(
  method: string,
  path: string,
  options: { cookie?: string | null; body?: unknown; beforeBatch?: Hook; overrides?: Partial<Env> } = {},
): Promise<ApiResult & { queries: number }> {
  const counter = countingDb(env.DB, { beforeBatch: options.beforeBatch });
  const response = await direct({ ...(options.overrides ?? {}), DB: counter.db }, method, path, {
    cookie: options.cookie,
    body: options.body,
  });
  return { status: response.status, body: await response.json(), queries: counter.count() };
}
