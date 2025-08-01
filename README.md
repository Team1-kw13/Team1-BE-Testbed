# OpenAI Realtime API 테스트 레포지토리

## 개요

OpenAI의 Realtime API에서 발생하는 이벤트들을 쉽게 추적하기 위한 프로젝트입니다.

기본적으로 손주의 백엔드 파트를 테스트 및 디버깅하기 위해 만들어졌습니다.
(손주의 백엔드 파트는 Trunk-based 개발을 활용하기에, 상세한 기능 테스트가 필수적입니다.)

WebSocket 방식으로 작동합니다.

## 기능

- OpenAI Realtime API 이벤트 추적
- 백엔드 파트 전반에 대한 테스트

현재는 API 명세 등이 확정된 바 없기에 OpenAI Realtime API 이벤트 추적만 지원합니다.  
API 및 이벤트 명세가 확정되면 이에따라 코드를 수정할 예정입니다.
