import { afterEach, describe, expect, it, vi } from "vitest";
import { readTheme } from "../src/web/theme";

// 테스트는 Workers 환경이라 localStorage가 없다. 저장값 정리만 보면 되므로 Map으로 흉내 낸다.
function fakeStorage(initial: Record<string, string>) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

describe("테마 저장값 읽기(naejeon.theme)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["violet", "deeplol"])("없앤 테마 %s는 다크로 열고 저장값도 dark로 고쳐 쓴다", (retired) => {
    const storage = fakeStorage({ "naejeon.theme": retired });
    vi.stubGlobal("localStorage", storage);
    expect(readTheme()).toBe("dark");
    expect(storage.items.get("naejeon.theme")).toBe("dark");
  });

  it("다크·라이트 저장값은 그대로 읽고 건드리지 않는다", () => {
    const storage = fakeStorage({ "naejeon.theme": "light" });
    vi.stubGlobal("localStorage", storage);
    expect(readTheme()).toBe("light");
    expect(storage.items.get("naejeon.theme")).toBe("light");
  });

  it("저장값이 없으면 다크로 열고 새로 적지 않는다(첫 방문 판정이 기기 저장값을 본다)", () => {
    const storage = fakeStorage({});
    vi.stubGlobal("localStorage", storage);
    expect(readTheme()).toBe("dark");
    expect(storage.items.has("naejeon.theme")).toBe(false);
  });

  it("모르는 값은 다크로 열되 고쳐 쓰지 않는다", () => {
    const storage = fakeStorage({ "naejeon.theme": "sepia" });
    vi.stubGlobal("localStorage", storage);
    expect(readTheme()).toBe("dark");
    expect(storage.items.get("naejeon.theme")).toBe("sepia");
  });
});
