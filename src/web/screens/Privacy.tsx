import { PRIVACY, PRIVACY_IS_DRAFT } from "../legal";

/**
 * 개인정보 처리방침(#/privacy). 로그인 없이 열린다.
 *
 * 초안이다: 이 저장소의 코드가 실제로 저장·처리하는 항목만 사실대로 적었고, 법률 문구를 확정하지 않았다.
 * 운영자 이름·연락처 등은 src/web/legal.ts에서 채운다. 저장 항목이 바뀌면 이 화면도 함께 고친다.
 * 근거 코드: migrations/*.sql(저장 항목), src/server/auth.ts·oauth.ts(로그인·세션),
 * src/server/ratelimit.ts(IP 처리), src/server/mutation.ts(요청 기록 14일), 화면의 localStorage 사용,
 * src/server/deletion.ts(모임 삭제·탈퇴).
 */
export function Privacy(props: { back: () => void; backLabel: string }) {
  return (
    <div className="screen privacy">
      <header className="screen-head">
        <button type="button" className="link" onClick={props.back}>
          {props.backLabel}
        </button>
        <h1>개인정보 처리방침</h1>
      </header>
      {PRIVACY_IS_DRAFT && (
        <p className="note warn" role="note">
          초안입니다. 운영자 정보가 아직 채워지지 않았고 법률 검토를 거치지 않았습니다.
        </p>
      )}
      <p className="hint">시행일: {PRIVACY.effectiveDate}</p>

      <section aria-labelledby="pv-who">
        <h2 id="pv-who">누가 처리하나요</h2>
        <dl className="privacy-facts">
          <dt>운영자</dt>
          <dd>{PRIVACY.operatorName}</dd>
          <dt>개인정보 보호책임자</dt>
          <dd>{PRIVACY.privacyOfficer}</dd>
          <dt>문의·삭제 요청</dt>
          <dd>{PRIVACY.contact}</dd>
        </dl>
        <p>
          이 서비스는 내전(사용자 설정 게임) 모임의 팀 편성과 경기 기록을 위한 개인 운영 서비스이며,
          라이엇 게임즈의 공식 서비스가 아닙니다.
        </p>
      </section>

      <section aria-labelledby="pv-items">
        <h2 id="pv-items">무엇을 저장하나요</h2>
        <div className="table-scroll">
          <table className="privacy-table">
            <thead>
              <tr>
                <th scope="col">항목</th>
                <th scope="col">누구의 것</th>
                <th scope="col">왜</th>
                <th scope="col">얼마나</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>로그인 수단(카카오·Google)과 그 수단이 주는 고유 번호, 계정 생성 시각</td>
                <td>모임 운영자</td>
                <td>운영자 본인 확인</td>
                <td>운영자가 탈퇴할 때까지(모임 탭 → 모임 삭제 · 탈퇴)</td>
              </tr>
              <tr>
                <td>
                  아이디로 가입한 경우: 아이디, 비밀번호의 해시(원래 비밀번호는 저장하지 않음, PBKDF2로 변환한 값),
                  복구 코드의 해시(원래 코드는 가입·재발급 때 화면에 한 번만 보여 주고 저장하지 않음), 마지막으로 바꾼
                  시각
                </td>
                <td>모임 운영자</td>
                <td>아이디·비밀번호 로그인, 비밀번호를 잊었을 때 다시 정하기</td>
                <td>운영자가 탈퇴할 때까지. 비밀번호·복구 코드를 바꾸면 이전 해시는 바로 덮어씀</td>
              </tr>
              <tr>
                <td>아이디·계정별 틀린 로그인·복구 시도 횟수(아이디는 비밀 키로 변환한 값만)</td>
                <td>로그인하는 사람</td>
                <td>비밀번호 추측 막기</td>
                <td>15분 단위로 세고 다음 구간에서 지움. 로그인에 성공하면 바로 지움</td>
              </tr>
              <tr>
                <td>모임 이름, 참가자 표시 이름(운영자가 입력한 닉네임), 실력 그룹(운영자가 정한 값)</td>
                <td>모임 참가자</td>
                <td>팀 편성과 기록 표시</td>
                <td>운영자가 모임을 삭제할 때까지</td>
              </tr>
              <tr>
                <td>경기 기록(팀, 포지션, 승패, 진영, 경기 시각), 변경 내역, 서포터 차례 기록, 시즌</td>
                <td>모임 참가자</td>
                <td>전적과 통계</td>
                <td>위와 같음</td>
              </tr>
              <tr>
                <td>로그인 세션 쿠키(계정 번호·로그인 수단·만료 시각을 서명한 값)</td>
                <td>모임 운영자</td>
                <td>로그인 유지</td>
                <td>최대 30일. 로그아웃하면 즉시 무효</td>
              </tr>
              <tr>
                <td>로그인 확인용 임시 쿠키(무작위 값)</td>
                <td>로그인하는 사람</td>
                <td>로그인 위조 방지</td>
                <td>10분. 로그인이 끝나면 바로 지움</td>
              </tr>
              <tr>
                <td>저장 요청 기록(요청 번호, 작업 종류, 내용의 해시, 결과)</td>
                <td>모임</td>
                <td>같은 저장이 두 번 되지 않게</td>
                <td>14일</td>
              </tr>
              <tr>
                <td>IP 주소를 비밀 키로 변환한 값(원래 주소는 저장하지 않음)과 요청 횟수</td>
                <td>방문자</td>
                <td>지나치게 잦은 요청 제한</td>
                <td>1분 단위로 세고 다음 구간에서 지움</td>
              </tr>
              <tr>
                <td>조회 링크·운영자 인수 링크(인수 링크는 원래 값이 아니라 해시만)</td>
                <td>모임</td>
                <td>로그인 없이 기록 보기, 운영자 넘기기</td>
                <td>조회 링크는 다시 만들 때까지, 인수 링크는 24시간 유효</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          <strong>받지 않는 것:</strong> 이메일, 실명, 전화번호, 프로필 사진, 생년월일. 아이디로 가입할 때도
          아이디와 비밀번호만 받습니다. 아이디는 로그인에만 쓰고 화면이나 백업 파일에 넣지 않습니다. 카카오에는
          동의 항목을 요청하지 않고, Google에는 로그인 확인(openid)만 요청합니다. 카카오·Google의
          접근 토큰은 로그인 확인에만 쓰고 저장하지 않습니다.
        </p>
      </section>

      <section aria-labelledby="pv-device">
        <h2 id="pv-device">이 기기에만 저장되는 것</h2>
        <p>
          작성 중인 편성, 마지막으로 연 모임, 고른 참가자 목록, 화면 테마, 조회 화면에서 고른 "내
          이름"은 브라우저 저장소에만 있고 서버로 보내지 않습니다(편성은 "이 팀으로 시작"을 누를 때만
          서버로 갑니다). 브라우저의 사이트 데이터를 지우면 사라집니다.
        </p>
      </section>

      <section aria-labelledby="pv-others">
        <h2 id="pv-others">다른 회사에 맡기거나 전달되는 것</h2>
        <ul>
          <li>
            Cloudflare: 서버와 데이터베이스를 운영합니다. 위 항목이 Cloudflare 설비(국외 포함)에
            저장·처리될 수 있습니다. 오류가 나면 시각·주소·오류 종류가 Cloudflare 로그에 남을 수
            있습니다(이름·토큰·세션 값은 남기지 않습니다).
          </li>
          <li>카카오·Google: 로그인할 때 해당 회사의 로그인 화면을 거칩니다.</li>
          <li>
            jsDelivr: 화면 글꼴(Pretendard)을 받아 오는 과정에서 브라우저가 jsDelivr에 접속합니다.
          </li>
        </ul>
        <p className="hint">국외 이전과 처리 위탁의 정확한 고지 범위는 확인이 필요합니다(초안).</p>
      </section>

      <section aria-labelledby="pv-rights">
        <h2 id="pv-rights">고치거나 지우고 싶을 때</h2>
        <ul>
          <li>
            운영자는 직접 지울 수 있습니다. 모임 탭의 <strong>모임 삭제 · 탈퇴</strong>에서 확인 문구를
            입력하면, 모임의 경기·참가자·변경 내역·설정·요청 기록이 서버에서 바로 지워지고 조회 링크가 더
            이상 열리지 않습니다. 지우기 직전에 백업 파일이 운영자의 기기로 내려받아지며, 그 파일은
            운영자가 보관합니다.
          </li>
          <li>
            탈퇴(계정 삭제)도 같은 화면에서 합니다. 운영 중인 모임이 있으면 먼저 다른 사람에게 넘기거나
            삭제해야 합니다. 탈퇴하면 로그인 기록(아이디로 가입했다면 아이디와 비밀번호·복구 코드의 해시도)이
            지워지고 모든 기기에서 로그아웃됩니다. 아이디로 가입한 계정은 탈퇴할 때 비밀번호를 한 번 더 확인합니다.
          </li>
          <li>
            참가자: 경기 기록은 여러 사람이 함께 쓰는 기록이라 한 사람의 기록만 따로 지우는 기능은
            없습니다. 모임 운영자에게 이름 변경(예: "참가자 7")이나 보관을 요청할 수 있습니다. 운영자에게
            연락할 수 없거나 응하지 않으면 아래 연락처로 요청해 주세요. 본인 확인(모임 조회 링크)을 거쳐
            처리하고 결과를 알려드립니다.
          </li>
          <li>
            데이터베이스(Cloudflare D1)는 지난 시점으로 되돌리는 기능(Time Travel)이 항상 켜져 있어, 지운
            내용도 일정 기간은 그 시점의 데이터베이스 기록에 남았다가 사라집니다. 그 기간은 Cloudflare 유료
            요금제에서 최대 30일, 무료 요금제에서 최대 7일입니다. 장애 복구가 아니면 이 기록을 꺼내 쓰지
            않습니다.
          </li>
        </ul>
        <p>
          연락처: <strong>{PRIVACY.contact}</strong>
        </p>
      </section>

      <p>
        <button type="button" className="link" onClick={props.back}>
          {props.backLabel}
        </button>
      </p>
    </div>
  );
}
