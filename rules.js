"use strict";

function calculateStats(matches, minGames = 50) {
  const p = new Map();
  for (const m of matches)
    for (const team of ["blue", "red"])
      for (const x of m[team]) {
        if (!p.has(x.name))
          p.set(x.name, {
            name: x.name,
            w: 0,
            n: 0,
            lanes: LANES.map(() => ({ w: 0, n: 0 })),
          });
        const s = p.get(x.name),
          win = m.winner === team;
        s.n++;
        s.w += win;
        if (Number.isInteger(x.lane)) {
          s.lanes[x.lane].n++;
          s.lanes[x.lane].w += win;
        }
      }
  return [...p.values()].sort(
    (a, b) =>
      (a.n < minGames) - (b.n < minGames) ||
      b.w / b.n - a.w / a.n ||
      b.n - a.n ||
      a.name.localeCompare(b.name),
  );
}
function stats() {
  return calculateStats(db.matches, MIN_RANK_GAMES);
}

// Count only matches where the two players were on the same team.
function calculateSynergy(matches, name, minGames = 50) {
  const teammates = new Map();
  for (const match of matches) {
    for (const team of ["blue", "red"])
      for (const player of match[team]) {
        if (player.name === name) continue;
        if (!teammates.has(player.name))
          teammates.set(player.name, { name: player.name, n: 0, w: 0, totalGames: 0 });
        teammates.get(player.name).totalGames++;
      }
    const team = ["blue", "red"].find((side) =>
      match[side].some((player) => player.name === name),
    );
    if (!team) continue;
    for (const player of match[team]) {
      if (player.name === name) continue;
      const row = teammates.get(player.name);
      row.n++;
      if (match.winner === team) row.w++;
    }
  }
  return [...teammates.values()].sort(
    (a, b) =>
      (a.totalGames < minGames) - (b.totalGames < minGames) ||
      Number(!a.n) - Number(!b.n) ||
      (b.n ? b.w / b.n : 0) - (a.n ? a.w / a.n : 0) ||
      b.n - a.n ||
      a.name.localeCompare(b.name, "ko"),
  );
}

function validTeams(v, allowUnknown = false) {
  if (!v) return false;
  const names = [];
  return (
    ["blue", "red"].every(
      (t) =>
        Array.isArray(v[t]) &&
        v[t].length === 5 &&
        v[t].every((x) => {
          if (
            !x ||
            typeof x.name !== "string" ||
            !x.name.trim() ||
            x.name.length > 40 ||
            !(
              (allowUnknown && x.lane === null) ||
              (Number.isInteger(x.lane) && x.lane >= 0 && x.lane < 5)
            )
          )
            return false;
          names.push(x.name.trim().normalize("NFC").toLocaleLowerCase());
          return true;
        }) &&
        new Set(v[t].filter((x) => x.lane !== null).map((x) => x.lane)).size ===
          v[t].filter((x) => x.lane !== null).length,
    ) && new Set(names).size === 10
  );
}
function validMatch(m) {
  return (
    !!m &&
    typeof m.id === "string" &&
    m.id.length > 0 &&
    m.id.length <= 100 &&
    Number.isFinite(m.time) &&
    ["blue", "red"].includes(m.winner) &&
    validTeams(m, true)
  );
}
function validPayload(v) {
  if (
    !v ||
    !Array.isArray(v.matches) ||
    v.matches.length > 20000 ||
    !(v.resetAt === null || Number.isFinite(v.resetAt)) ||
    (v.schemaVersion !== undefined && ![1, 2].includes(v.schemaVersion))
  )
    return false;
  if (v.featureOptions !== undefined && (!v.featureOptions || typeof v.featureOptions!=='object' || Array.isArray(v.featureOptions) || (v.featureOptions.elite !== undefined && !validLegacyElite(v.featureOptions.elite)) || (Object.prototype.hasOwnProperty.call(v.featureOptions,'skillGroups') && !validSkillGroups(v.featureOptions.skillGroups)))) return false;
  if (v.reports !== undefined && (!Array.isArray(v.reports) || v.reports.length>200 || !v.reports.every(validReport) || new Set(v.reports.map(r=>r.id)).size!==v.reports.length)) return false;
  const ids = new Set();
  if (
    !v.matches.every((m) => {
      if (!validMatch(m) || ids.has(m.id)) return false;
      ids.add(m.id);
      return true;
    })
  )
    return false;
  if (v.cyclePending != null && !validTeams(v.cyclePending)) return false;
  if (
    v.trash !== undefined &&
    (!Array.isArray(v.trash) ||
      v.trash.length > 20000 ||
      !v.trash.every(validMatch) ||
      new Set(v.trash.map((m) => m.id)).size !== v.trash.length)
  )
    return false;
  if (
    v.auditLog !== undefined &&
    (!Array.isArray(v.auditLog) ||
      v.auditLog.length > 200 ||
      !v.auditLog.every(
        (x) =>
          x &&
          Number.isFinite(x.time) &&
          typeof x.kind === "string" &&
          x.kind.length <= 80 &&
          Number.isInteger(x.before) &&
          Number.isInteger(x.after),
      ))
  )
    return false;
  return true;
}

function usedCycleLanes(name) {
  const start = ensureLocalCycle().startAt;
  return [
    ...new Set([
      ...rotationLanes(name),
      ...db.matches
        .filter(
          (m) =>
            m.source !== "sheet" &&
            m.rotationMode !== "support" &&
            m.time > start,
        )
        .flatMap((m) => [...m.blue, ...m.red])
        .filter((x) => x.name === name && Number.isInteger(x.lane))
        .map((x) => x.lane),
    ]),
  ];
}

function cycleStartTime() {
  return Math.max(
    Date.now(),
    ...db.matches.filter((m) => m.source !== "sheet").map((m) => m.time + 1),
  );
}

function countedCycle(teams) {
  const used = Object.fromEntries(
    [...new Set([...stats().map((p) => p.name), ...names])].map((name) => [
      name,
      [...usedCycleLanes(name)],
    ]),
  );
  for (const x of [...teams.blue, ...teams.red])
    used[x.name] = [...new Set([...(used[x.name] || []), x.lane])];
  return used;
}

function countedSupport(teams) {
  const used = Object.fromEntries(
    names
      .filter((name) => usedCycleLanes(name).includes(4))
      .map((name) => [name, true]),
  );
  for (const t of ["blue", "red"]) {
    const player = teams[t].find((x) => x.lane === 4);
    if (player) used[player.name] = true;
  }
  return used;
}

function reservedLane(x) {
  return rotationReserved(x);
}

function assertCycleAssignment(teams, allowReserved = false) {
  if (!locked) return;
  for (const x of [...teams.blue, ...teams.red])
    if (
      usedCycleLanes(x.name).includes(x.lane) &&
      !(allowReserved && rotationReserved(x))
    )
      throw Error(
        `${x.name} 님은 이번 순환에서 ${LANES[x.lane]}을 이미 플레이했습니다. 다른 포지션을 선택하세요.`,
      );
}

function assignTeam(list) {
  const pick = PERMS[Math.floor(Math.random() * PERMS.length)];
  return list.map((name,i)=>({name,lane:pick[i]}));
}

function estimate() {
  const p = stats(),
    strength = (t) =>
      assignment[t].reduce((sum, x) => {
        const s = p.find((p) => p.name === x.name),
          l = s?.lanes[x.lane];
        return (
          sum +
          ((0.5 * ((s?.w || 0) + 2)) / ((s?.n || 0) + 4) +
            (0.5 * ((l?.w || 0) + 2)) / ((l?.n || 0) + 4))
        );
      }, 0) / 5;
  const a = strength("blue"),
    b = strength("red");
  return (100 * a) / (a + b);
}

function teamRecord(team) {
  const key = team
    .map((x) => x.name)
    .sort()
    .join("\u0000");
  let n = 0,
    w = 0;
  for (const m of db.matches)
    for (const t of ["blue", "red"])
      if (
        m[t]
          .map((x) => x.name)
          .sort()
          .join("\u0000") === key
      ) {
        n++;
        w += m.winner === t;
      }
  return { n, w };
}
