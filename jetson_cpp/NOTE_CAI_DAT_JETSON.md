# Note cai dat bridge tren Jetson robot

Tai lieu nay danh rieng cho chuong trinh C++ bridge chay tren Jetson mo rong cua robot.

Luong chay dung:

```text
Web app -> MQTT broker -> Jetson bridge C++ -> Unitree SDK2/DDS -> may tinh motion cua robot
```

Jetson chi can cam day Ethernet vao may tinh trong luc copy/cai dat. Sau khi cai xong, Jetson tu ket noi WiFi va nhan lenh MQTT.

## 1. Thong tin can thay truoc khi cai

Dat cac bien nay theo robot thuc te:

```bash
ROBOT_USER=jetson
ROBOT_IP=192.168.1.150
SDK2_IFACE=eth0
REPO_URL=https://github.com/levanminhbkhcm/WEBAPP-CONTROL-GO2.git
```

`SDK2_IFACE` la interface mang Jetson dung de noi xuong may tinh motion cua robot. Day khong phai day Ethernet tam dung de nap chuong trinh tu may tinh.

Kiem tra interface tren Jetson:

```bash
ip link
```

## 2. Copy chuong trinh vao may Ubuntu moi

Cach khuyen dung la clone tu GitHub:

```bash
sudo apt update
sudo apt install -y git
git clone https://github.com/levanminhbkhcm/WEBAPP-CONTROL-GO2.git
cd WEBAPP-CONTROL-GO2
```

Neu copy tu may Windows sang Ubuntu bang `scp`:

```powershell
scp -r "D:\Du An\CĐVĐ\WEB APP" user_ubuntu@IP_UBUNTU:/home/user_ubuntu/WEBAPP-CONTROL-GO2
```

## 3. Vi tri sua WiFi fix trong code

File can sua:

```bash
nano jetson_cpp/src/wifi_config.hpp
```

Sua cac dong nay:

```cpp
inline constexpr const char* kWifiSsid = "TEN_WIFI_CUA_BAN";
inline constexpr const char* kWifiPassword = "MAT_KHAU_WIFI_CUA_BAN";
inline constexpr const char* kWifiInterface = "wlan0";
```

Kiem tra ten interface WiFi tren Jetson:

```bash
ip link
nmcli dev status
```

Neu WiFi khong phai `wlan0`, sua `kWifiInterface`.

Luu y: WiFi/password duoc bien dich vao file binary. Moi lan doi WiFi/password phai build lai va cai lai chuong trinh.

## 4. Cai thu vien tren Ubuntu/Jetson

```bash
sudo apt update
sudo apt install -y git cmake g++ build-essential \
  libyaml-cpp-dev libeigen3-dev libboost-all-dev libfmt-dev \
  libssl-dev nlohmann-json3-dev libpaho-mqtt-dev network-manager \
  mosquitto-clients
```

Neu Paho MQTT tren Ubuntu khong ho tro WebSocket/WSS, cai Paho tu source:

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
cd ..
```

Cai Unitree SDK2 C++:

```bash
git clone https://github.com/unitreerobotics/unitree_sdk2.git
cd unitree_sdk2
cmake -B build -DBUILD_EXAMPLES=OFF -DCMAKE_INSTALL_PREFIX=/usr/local
cmake --build build -j"$(nproc)"
sudo cmake --install build
sudo ldconfig
cd ..
```

## 5. Bien dich bridge

Neu build truc tiep tren Jetson:

```bash
cd ~/WEBAPP-CONTROL-GO2/jetson_cpp
cmake -B build -DUNITREE_WITH_SDK=ON -DCMAKE_PREFIX_PATH=/usr/local
cmake --build build -j"$(nproc)"
sudo cmake --install build
```

File sau khi cai:

```bash
/usr/local/bin/unitree_mqtt_bridge
```

Test nhanh file:

```bash
unitree_mqtt_bridge --help
```

Neu chua co robot/SDK2, build dry-run de test MQTT:

```bash
cd ~/WEBAPP-CONTROL-GO2/jetson_cpp
cmake -B build-dryrun -DUNITREE_WITH_SDK=OFF
cmake --build build-dryrun -j"$(nproc)"
./build-dryrun/unitree_mqtt_bridge --robot r1 --dry-run
```

## 6. Day chuong trinh da bien dich xuong robot

Neu build tren Jetson thi khong can buoc nay, vi `sudo cmake --install build` da cai vao `/usr/local/bin`.

Neu build tren may Ubuntu khac, chi copy binary sang Jetson khi 2 may cung kien truc:

```bash
uname -m
ssh $ROBOT_USER@$ROBOT_IP "uname -m"
```

Jetson thuong la `aarch64`. Neu may Ubuntu build la `x86_64`, binary build ra se khong chay tren Jetson. Khi do hay build truc tiep tren Jetson hoac dung cross-compile.

Copy binary va service sang Jetson:

```bash
scp jetson_cpp/build/unitree_mqtt_bridge $ROBOT_USER@$ROBOT_IP:/tmp/
scp jetson_cpp/unitree-mqtt-bridge.service $ROBOT_USER@$ROBOT_IP:/tmp/

ssh $ROBOT_USER@$ROBOT_IP "
  sudo install -m 755 /tmp/unitree_mqtt_bridge /usr/local/bin/unitree_mqtt_bridge &&
  sudo install -m 644 /tmp/unitree-mqtt-bridge.service /etc/systemd/system/unitree-mqtt-bridge.service &&
  sudo systemctl daemon-reload
"
```

## 7. Chay thu bridge tren Jetson

Chay thu R1:

```bash
unitree_mqtt_bridge \
  --robot r1 \
  --network-interface eth0 \
  --broker-url wss://broker.emqx.io:8084/mqtt \
  --topic-prefix unitree/cdvd
```

Neu interface SDK2 khac `eth0`, thay lai:

```bash
--network-interface ten_interface_sdk2
```

Neu muon bo qua tu ket noi WiFi khi dang test:

```bash
unitree_mqtt_bridge --robot r1 --network-interface eth0 --skip-wifi
```

## 8. Cau hinh tu chay khi khoi dong

Mo file service de kiem tra username va interface:

```bash
nano jetson_cpp/unitree-mqtt-bridge.service
```

Dong quan trong:

```ini
User=jetson
ExecStart=/usr/local/bin/unitree_mqtt_bridge --robot r1 --network-interface eth0 --broker-url wss://broker.emqx.io:8084/mqtt --topic-prefix unitree/cdvd
```

Cai service:

```bash
sudo cp jetson_cpp/unitree-mqtt-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now unitree-mqtt-bridge
```

Xem trang thai:

```bash
systemctl status unitree-mqtt-bridge
journalctl -u unitree-mqtt-bridge -f
```

Sau khi service da `enable`, co the rut day Ethernet nap chuong trinh. Lan khoi dong sau Jetson se tu ket noi WiFi va tu chay bridge.

## 9. Test ket noi MQTT

Topic can theo doi:

```text
unitree/cdvd/r1/command
unitree/cdvd/r1/robot/status
unitree/cdvd/r1/web/status
```

Theo doi tat ca topic R1:

```bash
mosquitto_sub -h broker.emqx.io -p 1883 -t 'unitree/cdvd/r1/#' -v
```

Gui lenh test bang MQTT:

```bash
mosquitto_pub -h broker.emqx.io -p 1883 \
  -t 'unitree/cdvd/r1/command' \
  -m '{"command":"forward_4s","label":"Di toi","robot":"r1","source":"manual-test"}'
```

Neu dung MQTTBox:

```text
Protocol: wss
Host: broker.emqx.io:8084/mqtt
Subscribe topic: unitree/cdvd/r1/#
Command topic: unitree/cdvd/r1/command
```

Khi bridge chay dung, topic `unitree/cdvd/r1/robot/status` se co JSON trang thai `connected`, `ready`, `activeCommand`.

## 10. Go cai dat khi khong su dung nua

Dung va tat auto-start:

```bash
sudo systemctl disable --now unitree-mqtt-bridge
```

Xoa service va binary:

```bash
sudo rm -f /etc/systemd/system/unitree-mqtt-bridge.service
sudo systemctl daemon-reload
sudo rm -f /usr/local/bin/unitree_mqtt_bridge
```

Xoa source/build neu khong can nua:

```bash
rm -rf ~/WEBAPP-CONTROL-GO2
```

Neu muon xoa profile WiFi ma bridge da tao:

```bash
nmcli connection show
sudo nmcli connection delete "TEN_WIFI_CUA_BAN"
```

## 11. Lenh kiem tra loi nhanh

Kiem tra WiFi:

```bash
nmcli dev status
nmcli radio wifi
```

Kiem tra binary thieu thu vien:

```bash
ldd /usr/local/bin/unitree_mqtt_bridge
```

Xem log bridge:

```bash
journalctl -u unitree-mqtt-bridge -n 100 --no-pager
```

Kiem tra MQTT broker co resolve duoc khong:

```bash
getent hosts broker.emqx.io
```
