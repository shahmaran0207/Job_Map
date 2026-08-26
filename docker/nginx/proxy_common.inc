# 모든 프록시 location 이 공유하는 설정.

proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header Connection '';

# 클라이언트가 보낸 Authorization 헤더를 엔진으로 흘려보내지 않는다.
# 엔진은 인증을 모르고, 토큰이 더 깊은 계층으로 퍼질 이유가 없다.
proxy_set_header Authorization '';

# 엔진 응답 헤더에서 내부 정보를 제거한다.
proxy_hide_header X-Powered-By;
proxy_hide_header Server;

# 등시선 계산은 수 초가 걸릴 수 있으나, 무한정 매달려 커넥션을 점유하게 두지 않는다.
proxy_connect_timeout 5s;
proxy_send_timeout    30s;
proxy_read_timeout    30s;

# 엔진이 죽었을 때 재시도로 부하를 증폭시키지 않는다.
proxy_next_upstream off;

add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy no-referrer always;
