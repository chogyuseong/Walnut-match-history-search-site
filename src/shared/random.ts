// 시드로 재현할 수 있는 난수. 편성 섞기(draft.ts)와 예시 모임 합성 데이터(demo.ts)가 같이 쓴다.
// 다른 모듈을 import하지 않는 잎 모듈로 둔다: 예시 모임 조각이 draft.ts를 끌어오면 첫 화면 조각 나눔이 바뀌어
// 첫 화면 JS가 예산(scripts/check-bundle.mjs)을 넘었다.

/** mulberry32. 바꾸면 같은 시드의 편성 섞기 결과와 예시 모임 데이터가 모두 달라진다. */
export function rngFromSeed(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
