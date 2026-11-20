import { useState, type ReactNode } from "react";

/**
 * 모임 탭의 묶음. 접고 펼 수 있고, 펼친 상태는 이 창에서 기억한다(다른 화면에 갔다 와도 그대로).
 * forceOpen이면 항상 펼친다(점검 중일 때 복원 구역).
 * id는 sessionStorage 키와 구역 바로 가기(Group.tsx block-nav)의 `group-block-${id}`에 쓰인다. 바꾸면 둘 다 맞춘다.
 */
export function GroupBlock(props: {
  id: string;
  title: string;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  const key = `naejeon.groupBlock.${props.id}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = sessionStorage.getItem(key);
      if (stored !== null) return stored === "1";
    } catch {
      // 기억하지 못하면 기본값.
    }
    return props.defaultOpen === true;
  });
  return (
    <details
      id={`group-block-${props.id}`}
      className={props.danger ? "group-block danger-block" : "group-block"}
      open={open || props.forceOpen === true}
      onToggle={(event) => {
        const next = (event.currentTarget as HTMLDetailsElement).open;
        setOpen(next);
        try {
          sessionStorage.setItem(key, next ? "1" : "0");
        } catch {
          // 무시
        }
      }}
    >
      <summary>{props.title}</summary>
      <div className="group-block-body">{props.children}</div>
    </details>
  );
}
