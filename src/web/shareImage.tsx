import { useEffect, useState } from "react";
import type { Draft } from "../shared/draft";
import { dayRecords } from "../shared/insights";
import { awardTitle, awardWinnersText, type SeasonSummary } from "../shared/seasonAwards";
import type { SessionSummary } from "../shared/sessionSummary";
import { isCounted, ratePercent, safeTimeZone } from "../shared/stats";
import { sideOfTeam, TEAMS, type MatchView, type Snapshot, type Team } from "../shared/types";
import { formatDate, formatRange, formatTime, nameMap, POSITION_LABEL, teamName, teamRoster, winnerText } from "./format";
import { Dialog } from "./ui";

/**
 * 결과 이미지(PNG). 서버 없이 이 기기에서 canvas로 그린다.
 * 넣는 것: 모임 이름, 날짜, 경기 번호, 팀 명단·포지션, 승리 팀, 진영, 개인 승패.
 * 넣지 않는 것: 실력 그룹·가중치·조회 링크(토큰)·라이엇 로고와 게임 이미지.
 * 색은 지금 고른 테마의 토큰 값을 읽어 쓴다(새 색을 만들지 않는다).
 */

const WIDTH = 1080;
const PAD = 56;

interface Palette {
  bg: string;
  surface: string;
  elevated: string;
  text: string;
  muted: string;
  line: string;
  brand: string;
  winBg: string;
  winText: string;
  winAccent: string;
  lossBg: string;
  lossText: string;
  lossAccent: string;
  font: string;
}

function palette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim();
  return {
    bg: v("--ih-bg"),
    surface: v("--ih-panel"),
    elevated: v("--ih-subtle"),
    text: v("--ih-text"),
    muted: v("--ih-text-secondary"),
    line: v("--ih-line"),
    brand: v("--ih-accent"),
    winBg: v("--ih-win-bg"),
    winText: v("--ih-win-text"),
    winAccent: v("--ih-win-accent"),
    lossBg: v("--ih-loss-bg"),
    lossText: v("--ih-loss-text"),
    lossAccent: v("--ih-loss-accent"),
    font: getComputedStyle(document.body).fontFamily,
  };
}

/** 화면과 같은 글꼴이 준비된 뒤에 그린다. 글꼴을 못 받으면 기기 글꼴(한글 포함)로 그린다. */
async function fontsReady(font: string): Promise<void> {
  if (!document.fonts) return;
  try {
    await Promise.all(
      ["400", "700", "800"].map((w) => document.fonts.load(`${w} 32px ${font}`, "가나다 0123 ABC")),
    );
    await document.fonts.ready;
  } catch {
    // 글꼴을 못 불러와도 기기 글꼴로 그린다.
  }
}

/** 너비를 넘으면 말줄임표로 자른다. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  const chars = [...text];
  while (chars.length > 1 && ctx.measureText(`${chars.join("")}…`).width > max) chars.pop();
  return `${chars.join("")}…`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function setFont(ctx: CanvasRenderingContext2D, p: Palette, weight: number, size: number) {
  ctx.font = `${weight} ${size}px ${p.font}`;
}

function newCanvas(height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("이 기기에서는 이미지를 만들 수 없어요.");
  ctx.textBaseline = "middle";
  return { canvas, ctx };
}

function drawFooter(ctx: CanvasRenderingContext2D, p: Palette, height: number, group: string, date: string) {
  ctx.strokeStyle = p.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, height - 92);
  ctx.lineTo(WIDTH - PAD, height - 92);
  ctx.stroke();
  setFont(ctx, p, 800, 30);
  ctx.fillStyle = p.text;
  ctx.textAlign = "left";
  ctx.fillText(fit(ctx, group, WIDTH - PAD * 2 - 260), PAD, height - 48);
  setFont(ctx, p, 500, 26);
  ctx.fillStyle = p.muted;
  ctx.textAlign = "right";
  ctx.fillText(date, WIDTH - PAD, height - 48);
  ctx.textAlign = "left";
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("이미지를 만들지 못했어요."))), "image/png"),
  );
}

/** 팀 상자 하나: 머리(팀·진영·승패)와 5명(포지션·이름). */
function drawTeamBox(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  match: MatchView,
  team: Team,
  nameOf: (id: string) => string,
  x: number,
  y: number,
  w: number,
  rowH: number,
) {
  const won = isCounted(match) ? match.winnerTeam === team : null;
  const side = sideOfTeam(team, match.teamASide);
  const h = 72 + rowH * 5 + 16;
  roundRect(ctx, x, y, w, h, 20);
  ctx.fillStyle = p.surface;
  ctx.fill();
  if (side === "blue" || side === "red") {
    ctx.fillStyle = side === "blue" ? p.winBg : p.lossBg;
    ctx.fill();
  }
  ctx.lineWidth = won ? 4 : 1.5;
  // 이긴 팀은 강조색, 아니면 진영 색 테두리(진영을 모르면 중립).
  ctx.strokeStyle = won ? p.brand : side === "blue" ? p.winAccent : side === "red" ? p.lossAccent : p.line;
  ctx.stroke();

  setFont(ctx, p, 800, 32);
  ctx.fillStyle = side === "blue" ? p.winText : side === "red" ? p.lossText : p.text;
  ctx.fillText(`${team === "A" ? "●" : "■"} ${teamName(team, match.teamASide)}`, x + 24, y + 40);
  if (won !== null) {
    ctx.textAlign = "right";
    setFont(ctx, p, 800, 30);
    ctx.fillStyle = p.text;
    ctx.fillText(won ? "승리" : "패배", x + w - 24, y + 40);
    ctx.textAlign = "left";
  }
  let rowY = y + 72 + rowH / 2;
  for (const entry of teamRoster(match, team)) {
    setFont(ctx, p, 600, 24);
    ctx.fillStyle = p.muted;
    const position = entry.position ? POSITION_LABEL[entry.position] : "";
    if (position) ctx.fillText(position, x + 24, rowY);
    ctx.fillStyle = p.text;
    const nameX = position ? x + 104 : x + 24;
    const name = fitSized(ctx, p, won ? 800 : 600, nameOf(entry.participantId), x + w - 24 - nameX, 30, 22);
    ctx.fillText(name, nameX, rowY);
    rowY += rowH;
  }
  return h;
}

/** 경기 한 건 이미지: 양 팀 명단과 승리 팀. */
export async function drawMatchImage(snapshot: Snapshot, match: MatchView): Promise<Blob> {
  const p = palette();
  await fontsReady(p.font);
  const nameOf = nameMap(snapshot);
  const tz = snapshot.group.timezone;
  const rowH = 58;
  const boxH = 72 + rowH * 5 + 16;
  const height = PAD + 150 + boxH + 48 + 110;
  const { canvas, ctx } = newCanvas(height);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, WIDTH, height);

  setFont(ctx, p, 800, 56);
  ctx.fillStyle = p.text;
  ctx.fillText(`${match.matchNo}경기`, PAD, PAD + 34);
  setFont(ctx, p, 600, 30);
  ctx.fillStyle = p.muted;
  const winner = match.winnerTeam;
  const summary = winner ? winnerText(winner, match.teamASide, "승리") : "결과 미확정";
  ctx.fillText(summary, PAD, PAD + 98);

  const boxW = (WIDTH - PAD * 2 - 24) / 2;
  const top = PAD + 150;
  TEAMS.forEach((team, i) => {
    drawTeamBox(ctx, p, match, team, nameOf, PAD + i * (boxW + 24), top, boxW, rowH);
  });
  drawFooter(
    ctx,
    p,
    height,
    snapshot.group.name,
    `${formatDate(match.playedAt, tz)} ${formatTime(match.playedAt, tz)}`,
  );
  return toBlob(canvas);
}

/**
 * 편성 이미지(준비 화면, 2026-11-07): 시작 전 편성의 블루팀·레드팀 5명(포지션별 이름), 모임 이름, 날짜.
 * 경기 이미지의 팀 상자(drawTeamBox)를 그대로 쓴다. 승패가 없는 경기 모양으로 넘기므로 승리·패배 표시는 없다.
 * 넣지 않는 것: 티어·서포터 횟수·기피 라인·대기자·조회 링크(비공개 정보).
 */
export async function drawDraftImage(draft: Draft, groupName: string, timeZone: string): Promise<Blob> {
  const p = palette();
  await fontsReady(p.font);
  const names = new Map(draft.people.map((person) => [person.key, person.name]));
  const nameOf = (key: string) => names.get(key) ?? "";
  const now = new Date().toISOString();
  // 화면의 팀 상자 그리기를 다시 쓰기 위한 계산용 경기 모양. 참가자 ID 자리에 초안 키를 넣는다.
  const shape: MatchView = {
    id: "draft",
    matchNo: 0,
    sessionId: null,
    state: "in_progress",
    source: "live",
    startedAt: null,
    endedAt: null,
    playedAt: now,
    confirmedAt: null,
    winnerTeam: null,
    teamASide: draft.teamASide ?? "blue",
    version: 0,
    roster: draft.slots.map((s) => ({ participantId: s.key, team: s.team, position: s.position })),
  };
  const rowH = 58;
  const boxH = 72 + rowH * 5 + 16;
  const height = PAD + 150 + boxH + 48 + 110;
  const { canvas, ctx } = newCanvas(height);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, WIDTH, height);

  setFont(ctx, p, 800, 56);
  ctx.fillStyle = p.text;
  ctx.fillText("오늘의 편성", PAD, PAD + 34);
  setFont(ctx, p, 600, 30);
  ctx.fillStyle = p.muted;
  ctx.fillText(`아직 시작 전 · ${formatTime(now, timeZone)} 기준`, PAD, PAD + 98);

  const boxW = (WIDTH - PAD * 2 - 24) / 2;
  const top = PAD + 150;
  TEAMS.forEach((team, i) => {
    drawTeamBox(ctx, p, shape, team, nameOf, PAD + i * (boxW + 24), top, boxW, rowH);
  });
  drawFooter(ctx, p, height, groupName, formatDate(now, timeZone));
  return toBlob(canvas);
}

/** 이름 목록을 너비에 맞춰 여러 줄로 나눈다(이름 중간에서는 끊지 않는다. 한 이름이 너무 길면 자른다). */
function wrapNames(ctx: CanvasRenderingContext2D, names: readonly string[], max: number): string[] {
  const lines: string[] = [];
  let line = "";
  names.forEach((raw, i) => {
    const name = fit(ctx, raw, max - 20) + (i < names.length - 1 ? "," : "");
    const next = line === "" ? name : `${line} ${name}`;
    if (line !== "" && ctx.measureText(next).width > max) {
      lines.push(line);
      line = name;
    } else {
      line = next;
    }
  });
  if (line !== "") lines.push(line);
  return lines;
}

/** 칸에 맞게 글자 크기를 줄인다(최소 크기에서도 넘치면 말줄임표). */
function fitSized(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  weight: number,
  text: string,
  max: number,
  size: number,
  min: number,
): string {
  for (let s = size; s >= min; s -= 2) {
    setFont(ctx, p, weight, s);
    if (ctx.measureText(text).width <= max) return text;
  }
  return fit(ctx, text, max);
}

/** 오늘의 결과 이미지: 확정 경기 목록(경기별 승리 팀 명단)과 개인 승패. 긴 이름은 줄을 바꿔 다섯 명을 모두 싣는다. */
export async function drawDayImage(snapshot: Snapshot, matches: readonly MatchView[]): Promise<Blob> {
  const p = palette();
  await fontsReady(p.font);
  const nameOf = nameMap(snapshot);
  const tz = snapshot.group.timezone;
  const confirmed = matches.filter(isCounted).sort((a, b) => a.matchNo - b.matchNo);
  const people = dayRecords(confirmed, nameOf);
  const innerW = WIDTH - PAD * 2;
  const namesW = innerW - 100 - 24;
  const lineH = 30;

  // 먼저 줄 수를 재서 높이를 정한다.
  const measure = newCanvas(1).ctx;
  const layout = confirmed.map((match) => {
    const winner = match.winnerTeam!;
    const loser: Team = winner === "A" ? "B" : "A";
    const names = (team: Team) => teamRoster(match, team).map((r) => nameOf(r.participantId));
    setFont(measure, p, 600, 24);
    const win = wrapNames(measure, names(winner), namesW);
    setFont(measure, p, 500, 24);
    const lose = wrapNames(measure, names(loser), namesW);
    return { match, winner, win, lose, h: 60 + (win.length + lose.length) * lineH + 14 };
  });
  const personRowH = 56;
  const personCols = 2;
  const personRows = Math.ceil(people.length / personCols);
  const height =
    PAD + 150 + 56 + layout.reduce((sum, l) => sum + l.h + 12, 0) + 40 + 56 + personRows * personRowH + 48 + 110;
  const { canvas, ctx } = newCanvas(height);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, WIDTH, height);

  setFont(ctx, p, 800, 56);
  ctx.fillStyle = p.text;
  ctx.fillText("오늘의 결과", PAD, PAD + 34);
  setFont(ctx, p, 600, 30);
  ctx.fillStyle = p.muted;
  ctx.fillText(`확정 ${confirmed.length}경기 · 참가 ${people.length}명`, PAD, PAD + 98);

  let y = PAD + 150;
  setFont(ctx, p, 800, 32);
  ctx.fillStyle = p.text;
  ctx.fillText("경기별 결과", PAD, y + 20);
  y += 56;
  for (const { match, winner, win, lose, h } of layout) {
    const side = sideOfTeam(winner, match.teamASide);
    roundRect(ctx, PAD, y, innerW, h, 16);
    ctx.fillStyle = p.surface;
    ctx.fill();
    if (side === "blue" || side === "red") {
      ctx.fillStyle = side === "blue" ? p.winBg : p.lossBg;
      ctx.fill();
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = p.line;
    ctx.stroke();
    // 왼쪽 막대: 이긴 팀의 진영(미상이면 중립)
    ctx.fillStyle = side === "blue" ? p.winAccent : side === "red" ? p.lossAccent : p.line;
    ctx.fillRect(PAD, y + 8, 8, h - 16);

    setFont(ctx, p, 800, 30);
    ctx.fillStyle = p.text;
    ctx.fillText(`${match.matchNo}경기`, PAD + 28, y + 34);
    setFont(ctx, p, 600, 24);
    ctx.fillStyle = p.muted;
    ctx.fillText(winnerText(winner, match.teamASide), PAD + 160, y + 34);
    ctx.textAlign = "right";
    ctx.fillText(formatTime(match.playedAt, tz), PAD + innerW - 24, y + 34);
    ctx.textAlign = "left";

    let lineY = y + 76;
    setFont(ctx, p, 800, 24);
    ctx.fillStyle = p.text;
    ctx.fillText("승", PAD + 28, lineY);
    setFont(ctx, p, 600, 24);
    for (const text of win) {
      ctx.fillText(text, PAD + 72, lineY);
      lineY += lineH;
    }
    setFont(ctx, p, 800, 24);
    ctx.fillStyle = p.muted;
    ctx.fillText("패", PAD + 28, lineY);
    setFont(ctx, p, 500, 24);
    for (const text of lose) {
      ctx.fillText(text, PAD + 72, lineY);
      lineY += lineH;
    }
    y += h + 12;
  }

  y += 40;
  setFont(ctx, p, 800, 32);
  ctx.fillStyle = p.text;
  ctx.fillText("개인 승패", PAD, y);
  y += 40;
  const colW = (innerW - 24) / personCols;
  people.forEach((row, i) => {
    const col = i % personCols;
    const r = Math.floor(i / personCols);
    const x = PAD + col * (colW + 24);
    const rowY = y + r * personRowH + personRowH / 2;
    if (r % 2 === 0) {
      ctx.fillStyle = p.elevated;
      ctx.fillRect(x, rowY - personRowH / 2 + 4, colW, personRowH - 8);
    }
    drawRecordRow(ctx, p, x, rowY, colW, row.name, row.wins, row.losses);
  });

  const day = confirmed[0] ?? matches[0];
  drawFooter(ctx, p, height, snapshot.group.name, day ? formatDate(day.playedAt, tz) : "");
  return toBlob(canvas);
}

/**
 * 개인 승패 한 칸: 왼쪽 이름, 오른쪽 "승률% · N승 M패 (G경기)"(전적 표기 규칙). 전적 글 폭을 재고 남은 폭에 이름을 맞춘다.
 */
function drawRecordRow(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  x: number,
  rowY: number,
  colW: number,
  name: string,
  wins: number,
  losses: number,
): void {
  const games = wins + losses;
  const record = `${ratePercent(wins, games)}% · ${wins}승 ${losses}패 (${games}경기)`;
  setFont(ctx, p, 800, 22);
  const recordW = ctx.measureText(record).width;
  ctx.fillStyle = p.text;
  const shown = fitSized(ctx, p, 700, name, Math.max(80, colW - recordW - 48), 26, 18);
  ctx.fillText(shown, x + 16, rowY);
  ctx.textAlign = "right";
  setFont(ctx, p, 800, 22);
  ctx.fillText(record, x + colW - 16, rowY);
  ctx.textAlign = "left";
}

/**
 * 오늘 요약 이미지(2026-11-07): 경기 수·참가 수, 개인 승패(승 많은 순), 서포터를 간 사람, 연승 중인 사람.
 * 집계는 src/shared/sessionSummary.ts, 그리기는 오늘의 결과 이미지의 개인 승패 칸·여러 줄 글 나누기를 그대로 쓴다.
 * 넣지 않는 것: 티어·가중치·기피 라인·서포터 횟수 보정값·조회 링크.
 */
export async function drawSessionSummaryImage(
  snapshot: Snapshot,
  summary: SessionSummary,
  dateLabel: string,
): Promise<Blob> {
  const p = palette();
  await fontsReady(p.font);
  const innerW = WIDTH - PAD * 2;
  const lineH = 36;
  const personRowH = 56;
  const personCols = 2;
  const personRows = Math.ceil(summary.people.length / personCols);

  const measure = newCanvas(1).ctx;
  setFont(measure, p, 600, 26);
  const supportText =
    summary.supporters.length > 0 ? summary.supporters.map((s) => `${s.name} ${s.count}번`).join(" · ") : "기록 없음";
  const streakText =
    summary.streaks.length > 0 ? summary.streaks.map((s) => `${s.name} ${s.wins}연승`).join(" · ") : "없음";
  const supportLines = wrapText(measure, supportText, innerW - 48);
  const streakLines = wrapText(measure, streakText, innerW - 48);
  const boxH = (lines: number) => 56 + lines * lineH;

  const height =
    PAD + 150 + 56 + personRows * personRowH + 40 + boxH(supportLines.length) + 12 + boxH(streakLines.length) + 48 + 110;
  const { canvas, ctx } = newCanvas(height);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, WIDTH, height);

  setFont(ctx, p, 800, 56);
  ctx.fillStyle = p.text;
  ctx.fillText("오늘 요약", PAD, PAD + 34);
  setFont(ctx, p, 600, 30);
  ctx.fillStyle = p.muted;
  ctx.fillText(
    fit(ctx, `${dateLabel} · 확정 ${summary.games}경기 · 참가 ${summary.people.length}명`, innerW),
    PAD,
    PAD + 98,
  );

  let y = PAD + 150;
  setFont(ctx, p, 800, 32);
  ctx.fillStyle = p.text;
  ctx.fillText("개인 승패 (승 많은 순)", PAD, y + 20);
  y += 56;
  const colW = (innerW - 24) / personCols;
  summary.people.forEach((row, i) => {
    // 승 많은 순서가 위에서 아래로 읽히도록 왼쪽 열을 먼저 채운다.
    const col = Math.floor(i / personRows);
    const r = i % personRows;
    const x = PAD + col * (colW + 24);
    const rowY = y + r * personRowH + personRowH / 2;
    if (r % 2 === 0) {
      ctx.fillStyle = p.elevated;
      ctx.fillRect(x, rowY - personRowH / 2 + 4, colW, personRowH - 8);
    }
    drawRecordRow(ctx, p, x, rowY, colW, row.name, row.wins, row.losses);
  });
  y += personRows * personRowH + 40;

  for (const [title, lines] of [
    ["서포터", supportLines],
    ["연승 중", streakLines],
  ] as const) {
    const h = boxH(lines.length);
    roundRect(ctx, PAD, y, innerW, h, 16);
    ctx.fillStyle = p.surface;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = p.line;
    ctx.stroke();
    setFont(ctx, p, 800, 26);
    ctx.fillStyle = p.text;
    ctx.fillText(title, PAD + 24, y + 30);
    setFont(ctx, p, 600, 26);
    let lineY = y + 30 + lineH;
    for (const line of lines) {
      ctx.fillText(line, PAD + 24, lineY);
      lineY += lineH;
    }
    y += h + 12;
  }

  drawFooter(ctx, p, height, snapshot.group.name, dateLabel);
  return toBlob(canvas);
}

/**
 * 시즌 요약 이미지: 요약 숫자와 시상 목록(근거 숫자 포함). 티어·기피 라인·조회 링크는 넣지 않는다.
 * 수상자 글이 길면 줄을 바꿔 모두 싣는다.
 */
export async function drawSeasonImage(snapshot: Snapshot, summary: SeasonSummary): Promise<Blob> {
  const p = palette();
  await fontsReady(p.font);
  const nameOf = nameMap(snapshot);
  const innerW = WIDTH - PAD * 2;
  const textW = innerW - 48;
  const lineH = 34;

  const measure = newCanvas(1).ctx;
  setFont(measure, p, 600, 26);
  const rows = summary.awards.map((award) => {
    const text = award.winners.length === 0 ? "해당 없음" : awardWinnersText(award, nameOf);
    return { title: awardTitle(award), lines: wrapText(measure, text, textW), none: award.winners.length === 0 };
  });
  const rowsH = rows.reduce((sum, r) => sum + 56 + r.lines.length * lineH + 12, 0);
  const height = PAD + 150 + 130 + 56 + rowsH + 48 + 110;
  const { canvas, ctx } = newCanvas(height);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, WIDTH, height);

  setFont(ctx, p, 800, 56);
  ctx.fillStyle = p.text;
  ctx.fillText(fit(ctx, `${summary.label} 요약`, innerW), PAD, PAD + 34);
  setFont(ctx, p, 600, 30);
  ctx.fillStyle = p.muted;
  ctx.fillText(
    `${formatRange(summary.startsOn, summary.endsOn, snapshot.group.timezone)}${summary.ongoing ? " · 진행 중" : ""}`,
    PAD,
    PAD + 98,
  );

  let y = PAD + 150;
  roundRect(ctx, PAD, y, innerW, 110, 16);
  ctx.fillStyle = p.surface;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = p.line;
  ctx.stroke();
  setFont(ctx, p, 800, 30);
  ctx.fillStyle = p.text;
  ctx.fillText(`${summary.games}경기 · 참가 ${summary.participants}명 · 내전 ${summary.days}일`, PAD + 24, y + 36);
  setFont(ctx, p, 600, 24);
  ctx.fillStyle = p.muted;
  const blue = summary.sides.known > 0 ? ratePercent(summary.sides.blueWins, summary.sides.known) : null;
  const busiest = summary.busiestDays[0];
  ctx.fillText(
    fit(
      ctx,
      [
        blue !== null ? `블루 : 레드 승률 ${blue}% : ${100 - blue}%` : "진영 기록 없음",
        busiest ? `가장 많이 한 날 ${busiest.date} (${busiest.games}경기)` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      innerW - 48,
    ),
    PAD + 24,
    y + 78,
  );
  y += 130;

  setFont(ctx, p, 800, 32);
  ctx.fillStyle = p.text;
  ctx.fillText("시상", PAD, y + 20);
  y += 56;
  for (const row of rows) {
    const h = 56 + row.lines.length * lineH;
    roundRect(ctx, PAD, y, innerW, h, 16);
    ctx.fillStyle = p.surface;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = p.line;
    ctx.stroke();
    setFont(ctx, p, 800, 26);
    ctx.fillStyle = p.text;
    ctx.fillText(row.title, PAD + 24, y + 30);
    setFont(ctx, p, 600, 26);
    ctx.fillStyle = row.none ? p.muted : p.text;
    let lineY = y + 30 + lineH;
    for (const line of row.lines) {
      ctx.fillText(line, PAD + 24, lineY);
      lineY += lineH;
    }
    y += h + 12;
  }

  drawFooter(ctx, p, height, snapshot.group.name, summary.label);
  return toBlob(canvas);
}

/** 글을 너비에 맞춰 여러 줄로 나눈다(공백에서 끊고, 한 낱말이 너무 길면 글자에서 끊는다). */
function wrapText(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line === "" ? word : `${line} ${word}`;
    if (ctx.measureText(next).width <= max) {
      line = next;
      continue;
    }
    if (line !== "") lines.push(line);
    let piece = "";
    for (const ch of word) {
      if (ctx.measureText(piece + ch).width > max && piece !== "") {
        lines.push(piece);
        piece = "";
      }
      piece += ch;
    }
    line = piece;
  }
  if (line !== "") lines.push(line);
  return lines.length > 0 ? lines : [""];
}

type ShareState =
  | { kind: "making" }
  | { kind: "ready"; blob: Blob; url: string; canShare: boolean }
  | { kind: "failed"; message: string };

function canShareFile(file: File): boolean {
  try {
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/**
 * 결과 이미지 창. 만든 이미지를 먼저 보여주고,
 * 파일 공유가 되는 기기는 [공유], 안 되면 [내려받기]를 주요 버튼으로 둔다.
 * 둘 다 안 되면 이미지를 길게 눌러 저장하라고 안내한다(이미지는 항상 보인다).
 */
export function ShareImageDialog(props: {
  title: string;
  fileName: string;
  make: () => Promise<Blob>;
  onClose: () => void;
}) {
  const [state, setState] = useState<ShareState>({ kind: "making" });
  const [message, setMessage] = useState<string | null>(null);
  const { make, fileName } = props;

  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    make()
      .then((blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        const file = new File([blob], fileName, { type: "image/png" });
        setState({ kind: "ready", blob, url, canShare: canShareFile(file) });
      })
      .catch((error: unknown) => {
        if (alive) {
          setState({
            kind: "failed",
            message: error instanceof Error ? error.message : "이미지를 만들지 못했어요.",
          });
        }
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
    // 창을 열 때 한 번만 만든다.
  }, []);

  const downloadable = typeof document !== "undefined" && "download" in document.createElement("a");

  async function share(blob: Blob) {
    const file = new File([blob], fileName, { type: "image/png" });
    try {
      await navigator.share({ files: [file], title: props.title });
      setMessage("공유했어요.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage("공유하지 못했어요. 내려받기나 길게 눌러 저장을 써 주세요.");
    }
  }

  function download(url: string) {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setMessage("내려받기를 시작했어요. 안 되면 이미지를 길게 눌러 저장해 주세요.");
  }

  return (
    <Dialog title={props.title} onClose={props.onClose}>
      {state.kind === "making" && <p role="status">이미지를 만드는 중…</p>}
      {state.kind === "failed" && (
        <p className="note warn" role="alert">
          {state.message}
        </p>
      )}
      {state.kind === "ready" && (
        <>
          <img className="share-preview" src={state.url} alt={`${props.title} 미리보기`} />
          <p className="hint">
            티어·조회 링크는 이미지에 넣지 않았어요. 버튼이 안 되면 이미지를 길게 눌러(컴퓨터는
            오른쪽 클릭) 저장해 주세요.
          </p>
          <div className="button-row">
            {state.canShare && (
              <button type="button" className="primary" onClick={() => void share(state.blob)}>
                공유
              </button>
            )}
            {downloadable && (
              <button
                type="button"
                className={state.canShare ? "secondary" : "primary"}
                onClick={() => download(state.url)}
              >
                내려받기
              </button>
            )}
          </div>
          {message && (
            <p className="hint" role="status">
              {message}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}

/** 파일 이름에 쓸 날짜(모임 시간대). */
export function fileDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: safeTimeZone(timeZone), year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}
