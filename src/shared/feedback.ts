/** 피드백 글 길이(글자 수). 화면 입력 칸과 서버가 같이 쓴다. 서버는 넘으면 자르지 않고 거절한다(보낸 사람이 알 수 있게). */
export const FEEDBACK_MAX_CHARS = 1000;
/** "ㅇ"·"." 같은 실수 전송을 거르는 최소 길이(앞뒤 공백 뺀 글자 수). */
export const FEEDBACK_MIN_CHARS = 5;
