# WEBAPP-CONTROL-GO2

Web application điều khiển robot Unitree R1/Go2 từ xa qua MQTT, nhận diện giọng nói tiếng Việt bằng Web Speech API.

Luồng điều khiển đúng:

```text
Web app -> MQTT broker -> C++ bridge trên Jetson mở rộng -> Unitree SDK2/DDS -> máy tính motion của robot
```

Web app không gửi lệnh trực tiếp xuống máy tính motion của robot.

## Thành phần

- Frontend: React/Vinext, chạy được trong Visual Studio Code bằng `pnpm dev`.
- MQTT broker mặc định: `wss://broker.emqx.io:8084/mqtt`.
- Web topic mặc định:
  - `unitree/cdvd/r1/command`
  - `unitree/cdvd/r1/robot/status`
  - `unitree/cdvd/r1/web/status`
- Jetson bridge chính: `jetson_cpp/src/main.cpp`.
- Python bridge trong `jetson/` chỉ là bản thử nhanh/dry-run cũ, không phải hướng triển khai chính.
- Robot mặc định để thử nghiệm: `R1`.

Ghi chú: SDK2 C++ hiện cung cấp high-level loco client trong namespace `unitree::robot::g1::LocoClient`; bridge dùng client này cho lựa chọn `R1`.

## Chạy web app

Trên Windows có thể chạy nhanh bằng file exe ở thư mục gốc:

```powershell
.\Run-WebApp.exe
```

Hoặc bấm đúp `Run-WebApp.exe` trong File Explorer. File này sẽ khởi động web app local và mở trình duyệt.

Nếu chạy trên máy khác mà exe báo thiếu Node.js/pnpm, cài Node.js 22 trở lên rồi chạy lại exe.

Chạy thủ công bằng Terminal:

```bash
pnpm install
pnpm dev
```

Mở URL local mà dev server in ra. Nhận diện giọng nói tiếng Việt cần Chrome hoặc Edge vì app dùng Web Speech API `vi-VN`.

## Cài đặt C++ bridge trên Jetson

Các bước dưới đây giả định Jetson chạy Ubuntu 20.04/22.04 và nối mạng được tới robot qua Ethernet.

1. Cài công cụ build và thư viện hệ thống:

```bash
sudo apt update
sudo apt install -y git cmake g++ build-essential \
  libyaml-cpp-dev libeigen3-dev libboost-all-dev libfmt-dev \
  libssl-dev nlohmann-json3-dev libpaho-mqtt-dev
```

Nếu `libpaho-mqtt-dev` trên Ubuntu của Jetson không hỗ trợ WebSocket/WSS, build Paho MQTT C từ source:

```bash
git clone https://github.com/eclipse/paho.mqtt.c.git
cd paho.mqtt.c
cmake -B build \
  -DPAHO_WITH_SSL=TRUE \
  -DPAHO_WITH_WEBSOCKETS=TRUE \
  -DPAHO_BUILD_SHARED=TRUE \
  -DPAHO_BUILD_STATIC=FALSE \
  -DPAHO_ENABLE_TESTING=FALSE
cmake --build build -j"$(nproc)"
sudo cmake --install build
sudo ldconfig
```

2. Cài Unitree SDK2 C++:

```bash
git clone https://github.com/unitreerobotics/unitree_sdk2.git
cd unitree_sdk2
cmake -B build -DBUILD_EXAMPLES=OFF -DCMAKE_INSTALL_PREFIX=/usr/local
cmake --build build -j"$(nproc)"
sudo cmake --install build
sudo ldconfig
```

3. Build bridge C++ của dự án:

```bash
cd ~/WEBAPP-CONTROL-GO2/jetson_cpp
cmake -B build -DUNITREE_WITH_SDK=ON -DCMAKE_PREFIX_PATH=/usr/local
cmake --build build -j"$(nproc)"
sudo cmake --install build
```

4. Tìm interface mạng nối robot:

```bash
ip link
```

Ví dụ interface là `eth0`, chạy bridge cho R1:

```bash
unitree_mqtt_bridge \
  --robot r1 \
  --network-interface eth0 \
  --broker-url wss://broker.emqx.io:8084/mqtt \
  --topic-prefix unitree/cdvd
```

Chạy dry-run để thử MQTT khi chưa cắm robot hoặc chưa cài SDK2:

```bash
cd ~/WEBAPP-CONTROL-GO2/jetson_cpp
cmake -B build-dryrun -DUNITREE_WITH_SDK=OFF
cmake --build build-dryrun -j"$(nproc)"
./build-dryrun/unitree_mqtt_bridge --robot r1 --dry-run
```

## Chạy C++ bridge bằng systemd

Sửa `jetson_cpp/unitree-mqtt-bridge.service` nếu username, thư mục repo hoặc interface mạng khác mẫu.

```bash
sudo cp jetson_cpp/unitree-mqtt-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now unitree-mqtt-bridge
journalctl -u unitree-mqtt-bridge -f
```

## Lệnh đã map

| Lệnh              | Thời gian | R1 SDK2                                  | Go2 SDK2                                         |
| ----------------- | --------- | ---------------------------------------- | ------------------------------------------------ |
| Đi tới            | 4s        | `LocoClient.SetVelocity(0.3, 0, 0, 4)`   | `SportClient.Move(0.3, 0, 0)` rồi `StopMove()`   |
| Đi lùi            | 4s        | `LocoClient.SetVelocity(-0.3, 0, 0, 4)`  | `SportClient.Move(-0.3, 0, 0)` rồi `StopMove()`  |
| Đi ngang trái     | 2s        | `LocoClient.SetVelocity(0, 0.25, 0, 2)`  | `SportClient.Move(0, 0.25, 0)` rồi `StopMove()`  |
| Đi ngang phải     | 2s        | `LocoClient.SetVelocity(0, -0.25, 0, 2)` | `SportClient.Move(0, -0.25, 0)` rồi `StopMove()` |
| Bắt tay           | -         | `LocoClient.ShakeHand(0/1)`              | `SportClient.Hello()`                            |
| Stand Up          | -         | `LocoClient.StandUp()`                   | `SportClient.StandUp()`                          |
| Stand Down        | -         | `LocoClient.Squat()`                     | `SportClient.StandDown()`                        |
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
