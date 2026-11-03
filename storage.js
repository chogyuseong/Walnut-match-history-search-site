"use strict";

async function googleRequest(action, extra = {}) {
  if (
    !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(
      config.scriptUrl || "",
    )
  )
    throw Error("올바른 Apps Script /exec 주소를 입력하세요.");
  if (action !== "read" && !session?.password)
    throw Error("기록을 변경하려면 연결 설정에서 모임 암호를 입력해 주세요.");
  const res = await fetch(config.scriptUrl, {
    method: "POST",
    credentials: "omit",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, password: session?.password, ...extra, ...(action==='write'?{skillGroupsProtocol:1}:{}) }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw Error(
      "연결 응답을 읽지 못했습니다. 웹 앱의 액세스가 모든 사용자이고 /exec 주소인지 확인하세요.",
    );
  }
  if (!res.ok || !data.ok) {
    if (data.code === "CONFLICT") {
      const e = Error(
        "다른 팀원이 먼저 수정했습니다. 최신 기록을 불러온 후 다시 시도하세요.",
      );
      e.conflict = true;
      throw e;
    }
    throw Error(data.error || "구글 시트 연결에 실패했습니다.");
  }
  return data;
}

async function pull() {
  const startRevision = rev;
  const data = await googleRequest("read");
  if (!validPayload(data.payload) || !Number.isInteger(data.revision))
    throw Error("공용 기록 형식을 확인해 주세요.");
  if (data.revision >= rev && rev === startRevision && !busy) {
    db = data.payload;
    rev = data.revision;
    try {
      localStorage.setItem(
        "rift-public-cache",
        JSON.stringify({ url: config.scriptUrl, payload: db, revision: rev }),
      );
    } catch {}
  }
  publicLoading = false;
  publicError = "";
  lastSyncedAt = Date.now();
}

function readLocalRecords() {
  let raw;
  try {
    raw = localStorage.getItem(LOCAL_RECORDS_KEY);
  } catch {
    throw Error(
      "브라우저 저장소를 사용할 수 없습니다. 일반 창에서 열거나 공용 저장을 연결해 주세요.",
    );
  }
  if (!raw) return { payload: { matches: [], resetAt: null }, version: null };
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw Error(
      "이 기기의 저장 기록을 읽지 못했습니다. 백업 파일로 복원해 주세요.",
    );
  }
  if (!validPayload(value.payload) || typeof value.version !== "string")
    throw Error("이 기기의 저장 기록 형식이 올바르지 않습니다.");
  return value;
}

function restoreLocalRecords() {
  const saved = readLocalRecords();
  db = saved.payload;
  assignment = db.cyclePending || null;
  if (assignment)
    names = [...assignment.blue, ...assignment.red].map((x) => x.name);
  localVersion = saved.version;
}

async function commit(next) {
  if (session?.expiresAt && session.expiresAt < Date.now()) {
    session = null;
    localStorage.removeItem("rift-google-session");
    sessionStorage.removeItem("rift-google-session");
    throw Error(
      "로그인이 만료되었습니다. 모임 암호로 다시 연결해 주세요. 입력 초안은 유지됩니다.",
    );
  }
  if (!demo && config.scriptUrl && !session?.password)
    throw Error(
      "조회 모드입니다. 기록 추가·수정·삭제는 연결 설정에서 모임 암호를 입력한 후 사용할 수 있습니다.",
    );
  if (publicLoading && !demo)
    throw Error("기록을 불러오는 중입니다. 잠시 후 다시 시도하세요.");
  if (busy) throw Error("저장 중입니다. 잠시 기다려 주세요.");
  if (!validPayload(next)) throw Error("기록 형식을 확인해 주세요.");
  next = {
    ...next,
    schemaVersion: 2,
    auditLog: [
      ...(db.auditLog || []),
      {
        time: Date.now(),
        kind:
          next.matches.length > db.matches.length
            ? "add"
            : next.matches.length < db.matches.length
              ? "delete"
              : "edit",
        before: db.matches.length,
        after: next.matches.length,
      },
    ].slice(-200),
  };
  busy = true;
  try {
    if (!demo) {
      if (session) {
        try {
          const result = await googleRequest("write", {
            payload: next,
            revision: rev,
          });
          if (!Number.isInteger(result.revision))
            throw Error(
              "저장 응답의 버전을 확인할 수 없습니다. 재시도하면 저장 여부를 확인합니다.",
            );
          rev = result.revision;
        } catch (e) {
          if (e.conflict) {
            busy = false;
            await pull();
            render();
          }
          throw e;
        }
      } else {
        const latest = readLocalRecords();
        if (latest.version !== localVersion) {
          db = latest.payload;
          localVersion = latest.version;
          render();
          throw Error(
            "다른 탭에서 기록이 변경되었습니다. 최신 내용을 확인하고 다시 시도해 주세요.",
          );
        }
        const version = crypto.randomUUID();
        try {
          localStorage.setItem(
            LOCAL_RECORDS_KEY,
            JSON.stringify({ version, payload: next }),
          );
        } catch {
          throw Error(
            "브라우저에 저장하지 못했습니다. 저장 공간을 확인하거나 공용 저장을 연결해 주세요. 입력 내용은 유지됩니다.",
          );
        }
        localVersion = version;
      }
    }
    db = next;
  } finally {
    busy = false;
  }
}
