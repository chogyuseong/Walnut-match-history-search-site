// Vite의 `?raw` 가져오기: 파일 내용을 문자열로 받는다(테마 대비 검사가 styles.css를 읽는 데 쓴다).
declare module "*?raw" {
  const content: string;
  export default content;
}
