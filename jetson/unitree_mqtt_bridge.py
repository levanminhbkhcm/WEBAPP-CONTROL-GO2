#!/usr/bin/env python3
"""
MQTT bridge for Unitree SDK2 robots running on Jetson.

Default robot target is R1. Use --dry-run to test MQTT without a robot SDK.
"""

from __future__ import annotations

import argparse
import json
import queue
import signal
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

import paho.mqtt.client as mqtt


DEFAULT_BROKER_URL = "wss://broker.emqx.io:8084/mqtt"
DEFAULT_TOPIC_PREFIX = "unitree/cdvd"


@dataclass(frozen=True)
class CommandSpec:
    label: str
    duration: float | None = None
    velocity: tuple[float, float, float] | None = None


COMMANDS: dict[str, CommandSpec] = {
    "forward_4s": CommandSpec("Đi tới", duration=4.0, velocity=(0.3, 0.0, 0.0)),
    "backward_4s": CommandSpec("Đi lùi", duration=4.0, velocity=(-0.3, 0.0, 0.0)),
    "left_2s": CommandSpec("Đi ngang trái", duration=2.0, velocity=(0.0, 0.25, 0.0)),
    "right_2s": CommandSpec("Đi ngang phải", duration=2.0, velocity=(0.0, -0.25, 0.0)),
    "shake_hand": CommandSpec("Bắt tay"),
    "stand_up": CommandSpec("Stand Up"),
    "stand_down": CommandSpec("Stand Down"),
    "heart": CommandSpec("Vẽ trái tim"),
    "celebrate": CommandSpec("Vui mừng"),
    "wave_hand": CommandSpec("Vẫy tay"),
    "front_handstand": CommandSpec("Đứng 2 chân trước"),
    "rear_upright": CommandSpec("Đứng 2 chân sau"),
    "stop": CommandSpec("Dừng"),
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def json_dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


class UnitreeAdapter:
    sdk_name = "dry-run"

    def execute(self, _command_id: str, spec: CommandSpec) -> None:
        if spec.duration:
            time.sleep(spec.duration)


class R1Adapter(UnitreeAdapter):
    sdk_name = "unitree_sdk2py.g1.loco.LocoClient"

    def __init__(self, network_interface: str) -> None:
        from unitree_sdk2py.core.channel import ChannelFactoryInitialize
        from unitree_sdk2py.g1.loco.g1_loco_client import LocoClient

        ChannelFactoryInitialize(0, network_interface)
        self.client = LocoClient()
        self.client.SetTimeout(10.0)
        self.client.Init()

    def execute(self, command_id: str, spec: CommandSpec) -> None:
        if spec.velocity and spec.duration:
            vx, vy, vyaw = spec.velocity
            self.client.SetVelocity(vx, vy, vyaw, spec.duration)
            time.sleep(spec.duration)
            self.client.StopMove()
            return

        if command_id == "shake_hand":
            self.client.ShakeHand()
            return
        if command_id == "stand_up":
            self.client.Squat2StandUp()
            return
        if command_id == "stand_down":
            self.client.StandUp2Squat()
            return
        if command_id in {"celebrate", "wave_hand"}:
            self.client.WaveHand(True)
            time.sleep(3.0)
            self.client.WaveHand(False)
            return
        if command_id == "stop":
            self.client.StopMove()
            return

        raise NotImplementedError(f"R1 chưa hỗ trợ lệnh: {command_id}")


class Go2Adapter(UnitreeAdapter):
    sdk_name = "unitree_sdk2py.go2.sport.SportClient"

    def __init__(self, network_interface: str) -> None:
        from unitree_sdk2py.core.channel import ChannelFactoryInitialize
        from unitree_sdk2py.go2.sport.sport_client import SportClient

        ChannelFactoryInitialize(0, network_interface)
        self.client = SportClient()
        self.client.SetTimeout(10.0)
        self.client.Init()

    def execute(self, command_id: str, spec: CommandSpec) -> None:
        if spec.velocity and spec.duration:
            vx, vy, vyaw = spec.velocity
            self.client.Move(vx, vy, vyaw)
            time.sleep(spec.duration)
            self.client.StopMove()
            return

        if command_id == "shake_hand":
            self.client.Hello()
            return
        if command_id == "stand_up":
            self.client.StandUp()
            return
        if command_id == "stand_down":
            self.client.StandDown()
            return
        if command_id == "heart":
            self.client.Heart()
            return
        if command_id == "celebrate":
            self.client.Dance1()
            return
        if command_id == "wave_hand":
            self.client.Hello()
            return
        if command_id == "front_handstand":
            self.client.HandStand(True)
            return
        if command_id == "rear_upright":
            self.client.WalkUpright(True)
            return
        if command_id == "stop":
            self.client.StopMove()
            return

        raise NotImplementedError(f"Go2 chưa hỗ trợ lệnh: {command_id}")


def build_adapter(robot: str, network_interface: str, dry_run: bool) -> UnitreeAdapter:
    if dry_run:
        return UnitreeAdapter()

    if not network_interface:
        raise ValueError("Cần truyền --network-interface khi chạy với SDK2 thật")

    if robot == "r1":
        return R1Adapter(network_interface)
    if robot == "go2":
        return Go2Adapter(network_interface)

    raise ValueError(f"Robot không hợp lệ: {robot}")


def parse_broker_url(raw_url: str) -> dict[str, Any]:
    parsed = urlparse(raw_url)

    if parsed.scheme in {"ws", "wss"}:
        return {
            "host": parsed.hostname or "broker.emqx.io",
            "port": parsed.port or (443 if parsed.scheme == "wss" else 80),
            "transport": "websockets",
            "tls": parsed.scheme == "wss",
            "path": parsed.path or "/mqtt",
        }

    if parsed.scheme in {"mqtt", "tcp"}:
        return {
            "host": parsed.hostname or "broker.emqx.io",
            "port": parsed.port or 1883,
            "transport": "tcp",
            "tls": False,
            "path": None,
        }

    return {
        "host": raw_url,
        "port": 1883,
        "transport": "tcp",
        "tls": False,
        "path": None,
    }


class Bridge:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.robot = args.robot
        self.base_topic = f"{args.topic_prefix.strip('/')}/{self.robot}"
        self.command_topic = f"{self.base_topic}/command"
        self.robot_status_topic = f"{self.base_topic}/robot/status"
        self.web_status_topic = f"{self.base_topic}/web/status"
        self.commands: queue.Queue[dict[str, Any]] = queue.Queue()
        self.stop_event = threading.Event()
        self.web_connected = False
        self.ready = False
        self.active_command: str | None = None
        self.active_command_label: str | None = None

        self.adapter = build_adapter(
            self.robot,
            args.network_interface,
            args.dry_run,
        )

        broker = parse_broker_url(args.broker_url)
        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=args.client_id,
            clean_session=True,
            transport=broker["transport"],
        )

        if broker["transport"] == "websockets":
            self.client.ws_set_options(path=broker["path"])
        if broker["tls"]:
            self.client.tls_set()

        self.host = broker["host"]
        self.port = broker["port"]

        self.client.will_set(
            self.robot_status_topic,
            payload=json_dumps(self.status_payload(False, "offline", "Jetson offline")),
            qos=0,
            retain=True,
        )
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message
        self.client.on_disconnect = self.on_disconnect

    def status_payload(
        self,
        connected: bool,
        state: str,
        message: str,
        last_command: str | None = None,
    ) -> dict[str, Any]:
        return {
            "client": "jetson",
            "robot": self.robot,
            "connected": connected,
            "ready": self.ready and connected and not self.active_command,
            "state": state,
            "activeCommand": self.active_command,
            "activeCommandLabel": self.active_command_label,
            "lastCommand": last_command,
            "message": message,
            "sdk": self.adapter.sdk_name,
            "webConnected": self.web_connected,
            "updatedAt": utc_now(),
        }

    def publish_status(
        self,
        connected: bool,
        state: str,
        message: str,
        last_command: str | None = None,
    ) -> None:
        self.client.publish(
            self.robot_status_topic,
            json_dumps(self.status_payload(connected, state, message, last_command)),
            qos=0,
            retain=True,
        )

    def on_connect(
        self,
        client: mqtt.Client,
        _userdata: Any,
        _flags: Any,
        reason_code: Any,
        _properties: Any,
    ) -> None:
        if reason_code != 0:
            print(f"MQTT connect failed: {reason_code}", file=sys.stderr)
            return

        self.ready = True
        client.subscribe(self.command_topic, qos=0)
        client.subscribe(self.web_status_topic, qos=0)
        self.publish_status(True, "ready", "Robot sẵn sàng nhận lệnh")
        print(f"Subscribed: {self.command_topic}")
        print(f"Status: {self.robot_status_topic}")

    def on_disconnect(
        self,
        _client: mqtt.Client,
        _userdata: Any,
        reason_code: Any,
        _properties: Any,
    ) -> None:
        print(f"MQTT disconnected: {reason_code}", file=sys.stderr)

    def on_message(
        self,
        _client: mqtt.Client,
        _userdata: Any,
        message: mqtt.MQTTMessage,
    ) -> None:
        try:
            payload = json.loads(message.payload.decode("utf-8"))
        except json.JSONDecodeError:
            self.publish_status(True, "error", "Payload MQTT không phải JSON")
            return

        if message.topic == self.web_status_topic:
            self.web_connected = bool(payload.get("connected"))
            self.publish_status(True, "ready", "Đã cập nhật trạng thái web")
            return

        if message.topic == self.command_topic:
            self.commands.put(payload)

    def worker(self) -> None:
        while not self.stop_event.is_set():
            try:
                payload = self.commands.get(timeout=0.25)
            except queue.Empty:
                continue

            command_id = str(payload.get("command", ""))
            spec = COMMANDS.get(command_id)

            if not spec:
                self.publish_status(True, "error", f"Lệnh không hợp lệ: {command_id}")
                continue

            self.ready = False
            self.active_command = command_id
            self.active_command_label = spec.label
            self.publish_status(True, "executing", f"Đang thực thi: {spec.label}")

            try:
                self.adapter.execute(command_id, spec)
            except Exception as exc:  # noqa: BLE001 - keep bridge alive for next command.
                self.active_command = None
                self.active_command_label = None
                self.ready = True
                self.publish_status(True, "error", f"Lỗi SDK2: {exc}", command_id)
                continue

            self.active_command = None
            self.active_command_label = None
            self.ready = True
            self.publish_status(True, "ready", f"Hoàn tất: {spec.label}", command_id)

    def run(self) -> None:
        worker = threading.Thread(target=self.worker, daemon=True)
        worker.start()
        self.client.connect(self.host, self.port, keepalive=60)
        self.client.loop_start()

        try:
            while not self.stop_event.is_set():
                time.sleep(0.5)
        finally:
            self.ready = False
            self.publish_status(False, "offline", "Jetson dừng chương trình")
            self.client.loop_stop()
            self.client.disconnect()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Unitree SDK2 MQTT bridge")
    parser.add_argument("--robot", choices=["r1", "go2"], default="r1")
    parser.add_argument("--broker-url", default=DEFAULT_BROKER_URL)
    parser.add_argument("--topic-prefix", default=DEFAULT_TOPIC_PREFIX)
    parser.add_argument("--network-interface", default="")
    parser.add_argument("--client-id", default=f"unitree-jetson-{int(time.time())}")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    bridge = Bridge(args)

    def stop(_signum: int, _frame: Any) -> None:
        bridge.stop_event.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    bridge.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
