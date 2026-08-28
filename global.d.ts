// CSS 사이드이펙트 import 를 위한 선언.
// Next 가 번들 단계에서 처리하지만 tsc 단독 실행에는 타입 선언이 필요하다.
declare module '*.css';
