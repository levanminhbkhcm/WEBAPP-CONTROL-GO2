# WEBAPP-CONTROL-GO2

Web application điều khiển robot Unitree R1/Go2 từ xa qua MQTT, nhận diện giọng nói tiếng Việt bằng Web Speech API và gửi lệnh high level tới chương trình chạy trên Jetson.

## Thành phần

- Frontend: React/Vinext, chạy được trong Visual Studio Code bằng `pnpm dev`.
- MQTT broker mặc định: `wss://broker.emqx.io:8084/mqtt`.
- Web topic mặc định:
  - `unitree/cdvd/r1/command`
  - `unitree/cdvd/r1/robot/status`
  - `unitree/cdvd/r1/web/status`
- Jetson bridge: `jetson/unitree_mqtt_bridge.py`.
- Robot mặc định để thử nghiệm: `R1`.

## Chạy web app

```bash
pnpm install
pnpm dev
```

Mở URL local mà dev server in ra. Nhận diện giọng nói tiếng Việt cần Chrome hoặc Edge vì app dùng Web Speech API `vi-VN`.

## Chạy chương trình Jetson

Trên Jetson, cài SDK2 Python chính thức của Unitree trước, sau đó cài MQTT dependency:

```bash
python3 -m pip install -r jetson/requirements.txt
```

Chạy thử MQTT không gọi robot thật:

```bash
python3 jetson/unitree_mqtt_bridge.py --robot r1 --dry-run
```

Chạy với R1 thật:

```bash
python3 jetson/unitree_mqtt_bridge.py \
  --robot r1 \
  --network-interface eth0 \
  --broker-url wss://broker.emqx.io:8084/mqtt \
  --topic-prefix unitree/cdvd
```

Đổi `eth0` thành interface đang nối mạng robot nếu Jetson dùng tên khác.

## Lệnh đã map

| Lệnh              | Thời gian | R1 SDK2                                  | Go2 SDK2                                         |
| ----------------- | --------- | ---------------------------------------- | ------------------------------------------------ |
| Đi tới            | 4s        | `LocoClient.SetVelocity(0.3, 0, 0, 4)`   | `SportClient.Move(0.3, 0, 0)` rồi `StopMove()`   |
| Đi lùi            | 4s        | `LocoClient.SetVelocity(-0.3, 0, 0, 4)`  | `SportClient.Move(-0.3, 0, 0)` rồi `StopMove()`  |
| Đi ngang trái     | 2s        | `LocoClient.SetVelocity(0, 0.25, 0, 2)`  | `SportClient.Move(0, 0.25, 0)` rồi `StopMove()`  |
| Đi ngang phải     | 2s        | `LocoClient.SetVelocity(0, -0.25, 0, 2)` | `SportClient.Move(0, -0.25, 0)` rồi `StopMove()` |
| Bắt tay           | -         | `LocoClient.ShakeHand()`                 | `SportClient.Hello()`                            |
| Stand Up          | -         | `LocoClient.Squat2StandUp()`             | `SportClient.StandUp()`                          |
| Stand Down        | -         | `LocoClient.StandUp2Squat()`             | `SportClient.StandDown()`                        |
| Vẽ trái tim       | -         | Chưa bật cho R1                          | `SportClient.Heart()`                            |
| Vui mừng          | -         | `LocoClient.WaveHand(True/False)`        | `SportClient.Dance1()`                           |
| Đứng 2 chân trước | -         | Chưa bật cho R1                          | `SportClient.HandStand(True)`                    |
| Đứng 2 chân sau   | -         | Chưa bật cho R1                          | `SportClient.WalkUpright(True)`                  |
| Dừng              | -         | `LocoClient.StopMove()`                  | `SportClient.StopMove()`                         |

## Payload MQTT

Web gửi JSON tới topic `unitree/cdvd/<robot>/command`:

```json
{
  "id": "cmd-...",
  "robot": "r1",
  "command": "forward_4s",
  "label": "Đi tới",
  "durationMs": 4000,
  "velocity": { "vx": 0.3, "vy": 0, "vyaw": 0 },
  "source": "voice",
  "rawText": "robot đi tới",
  "issuedAt": "2026-09-04T00:00:00.000Z"
}
```

Jetson publish trạng thái retained tới `unitree/cdvd/<robot>/robot/status` để web đọc được trạng thái kết nối, sẵn sàng và lệnh đang thực thi.

## Ghi chú an toàn

Các vận tốc mặc định đang để mức thấp để thử nghiệm. Khi chạy robot thật, kiểm tra vùng di chuyển, pin, chế độ vận hành và nút dừng vật lý trước khi gửi lệnh.
