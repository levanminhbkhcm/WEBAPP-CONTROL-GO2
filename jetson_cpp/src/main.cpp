#include <MQTTClient.h>
#include <nlohmann/json.hpp>

#include "wifi_config.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <exception>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

#ifndef UNITREE_WITH_SDK
#define UNITREE_WITH_SDK 1
#endif

#if UNITREE_WITH_SDK
#include <unitree/robot/channel/channel_factory.hpp>
#include <unitree/robot/g1/loco/g1_loco_client.hpp>
#include <unitree/robot/go2/sport/sport_client.hpp>
#endif

using json = nlohmann::json;

namespace {

constexpr const char* kDefaultBrokerUrl = "wss://broker.emqx.io:8084/mqtt";
constexpr const char* kDefaultTopicPrefix = "unitree/cdvd";

struct Args {
  std::string robot = "r1";
  std::string broker_url = kDefaultBrokerUrl;
  std::string topic_prefix = kDefaultTopicPrefix;
  std::string network_interface;
  std::string client_id = "unitree-jetson-cpp";
  bool dry_run = false;
  bool insecure_tls = false;
  bool skip_wifi = false;
};

struct Velocity {
  float vx;
  float vy;
  float vyaw;
};

struct CommandSpec {
  std::string label;
  std::optional<std::chrono::milliseconds> duration;
  std::optional<Velocity> velocity;
};

const std::map<std::string, CommandSpec> kCommands = {
    {"forward_4s", {"Đi tới", std::chrono::milliseconds(4000), Velocity{0.3f, 0.0f, 0.0f}}},
    {"backward_4s", {"Đi lùi", std::chrono::milliseconds(4000), Velocity{-0.3f, 0.0f, 0.0f}}},
    {"left_2s", {"Đi ngang trái", std::chrono::milliseconds(2000), Velocity{0.0f, 0.25f, 0.0f}}},
    {"right_2s", {"Đi ngang phải", std::chrono::milliseconds(2000), Velocity{0.0f, -0.25f, 0.0f}}},
    {"shake_hand", {"Bắt tay", std::nullopt, std::nullopt}},
    {"stand_up", {"Stand Up", std::nullopt, std::nullopt}},
    {"stand_down", {"Stand Down", std::nullopt, std::nullopt}},
    {"heart", {"Vẽ trái tim", std::nullopt, std::nullopt}},
    {"celebrate", {"Vui mừng", std::nullopt, std::nullopt}},
    {"wave_hand", {"Vẫy tay", std::nullopt, std::nullopt}},
    {"front_handstand", {"Đứng 2 chân trước", std::nullopt, std::nullopt}},
    {"rear_upright", {"Đứng 2 chân sau", std::nullopt, std::nullopt}},
    {"stop", {"Dừng", std::nullopt, std::nullopt}},
};

std::atomic_bool* g_stop_flag = nullptr;

void handle_signal(int) {
  if (g_stop_flag != nullptr) {
    g_stop_flag->store(true);
  }
}

std::string usage(const char* program) {
  std::ostringstream output;
  output
      << "Usage: " << program << " [options]\n\n"
      << "Options:\n"
      << "  --robot r1|go2\n"
      << "  --network-interface eth0\n"
      << "  --broker-url wss://broker.emqx.io:8084/mqtt\n"
      << "  --topic-prefix unitree/cdvd\n"
      << "  --client-id unitree-jetson-cpp\n"
      << "  --dry-run\n"
      << "  --skip-wifi\n"
      << "  --insecure-tls\n";
  return output.str();
}

std::pair<std::string, std::string> parse_option(
    int& index,
    int argc,
    char** argv) {
  std::string current = argv[index];
  const auto equals = current.find('=');

  if (equals != std::string::npos) {
    return {current.substr(2, equals - 2), current.substr(equals + 1)};
  }

  if (index + 1 >= argc || std::string(argv[index + 1]).rfind("--", 0) == 0) {
    return {current.substr(2), ""};
  }

  index += 1;
  return {current.substr(2), argv[index]};
}

Args parse_args(int argc, char** argv) {
  Args args;
  args.client_id += "-" + std::to_string(std::time(nullptr));

  for (int index = 1; index < argc; ++index) {
    std::string token = argv[index];

    if (token == "--help" || token == "-h") {
      std::cout << usage(argv[0]);
      std::exit(0);
    }

    if (token == "--dry-run") {
      args.dry_run = true;
      continue;
    }

    if (token == "--insecure-tls") {
      args.insecure_tls = true;
      continue;
    }

    if (token == "--skip-wifi") {
      args.skip_wifi = true;
      continue;
    }

    if (token.rfind("--", 0) != 0) {
      throw std::invalid_argument("Unexpected argument: " + token);
    }

    auto [key, value] = parse_option(index, argc, argv);

    if (key == "robot") {
      args.robot = value;
    } else if (key == "network-interface") {
      args.network_interface = value;
    } else if (key == "broker-url") {
      args.broker_url = value;
    } else if (key == "topic-prefix") {
      args.topic_prefix = value;
    } else if (key == "client-id") {
      args.client_id = value;
    } else {
      throw std::invalid_argument("Unknown option: --" + key);
    }
  }

  if (args.robot != "r1" && args.robot != "go2") {
    throw std::invalid_argument("--robot must be r1 or go2");
  }

  if (!args.dry_run && args.network_interface.empty()) {
    throw std::invalid_argument(
        "--network-interface is required when not using --dry-run");
  }

  return args;
}

std::string shell_quote(const std::string& value) {
  std::string quoted = "'";
  for (char ch : value) {
    if (ch == '\'') {
      quoted += "'\"'\"'";
    } else {
      quoted += ch;
    }
  }
  quoted += "'";
  return quoted;
}

bool run_shell_quiet(const std::string& command) {
  return std::system((command + " >/dev/null 2>&1").c_str()) == 0;
}

bool is_wifi_placeholder() {
  const std::string ssid = wifi_config::kWifiSsid;
  const std::string password = wifi_config::kWifiPassword;
  return ssid.empty() || password.empty() ||
         ssid == "TEN_WIFI_CUA_BAN" ||
         password == "MAT_KHAU_WIFI_CUA_BAN";
}

bool wifi_is_connected() {
  const std::string iface = wifi_config::kWifiInterface;
  return run_shell_quiet(
      "nmcli -t -f DEVICE,STATE dev status | grep -Fxq " +
      shell_quote(iface + ":connected"));
}

bool connectivity_is_ready() {
  return run_shell_quiet(
      "getent hosts " + shell_quote(wifi_config::kConnectivityCheckHost));
}

void ensure_wifi_connected(const Args& args) {
  if (args.skip_wifi || !wifi_config::kEnableWifiAutoConnect) {
    std::cout << "WiFi auto connect: skipped\n";
    return;
  }

  if (is_wifi_placeholder()) {
    throw std::runtime_error(
        "WiFi SSID/password chua duoc cau hinh trong "
        "jetson_cpp/src/wifi_config.hpp");
  }

  if (!run_shell_quiet("command -v nmcli")) {
    throw std::runtime_error(
        "Khong tim thay nmcli. Cai NetworkManager bang: "
        "sudo apt install -y network-manager");
  }

  const std::string iface = wifi_config::kWifiInterface;
  const std::string ssid = wifi_config::kWifiSsid;
  const std::string password = wifi_config::kWifiPassword;
  const std::string connect_command =
      "nmcli dev wifi connect " + shell_quote(ssid) +
      " password " + shell_quote(password) +
      " ifname " + shell_quote(iface);

  std::cout << "WiFi auto connect: interface=" << iface
            << ", ssid=" << ssid << '\n';

  run_shell_quiet("nmcli radio wifi on");
  run_shell_quiet("nmcli dev wifi rescan ifname " + shell_quote(iface));

  const auto deadline = std::chrono::steady_clock::now() +
                        std::chrono::seconds(
                            wifi_config::kWifiConnectTimeoutSeconds);
  auto last_connect_attempt = std::chrono::steady_clock::time_point::min();

  while (std::chrono::steady_clock::now() < deadline) {
    if (wifi_is_connected() && connectivity_is_ready()) {
      std::cout << "WiFi auto connect: connected and internet ready\n";
      return;
    }

    const auto now = std::chrono::steady_clock::now();
    if (last_connect_attempt == std::chrono::steady_clock::time_point::min() ||
        now - last_connect_attempt >= std::chrono::seconds(10)) {
      last_connect_attempt = now;
      run_shell_quiet(connect_command);
    }

    std::this_thread::sleep_for(std::chrono::seconds(1));
  }

  throw std::runtime_error(
      "Khong ket noi duoc WiFi hoac khong resolve duoc broker trong thoi gian "
      "cho. Kiem tra SSID/password, interface WiFi va internet.");
}

std::string trim_slashes(std::string value) {
  while (!value.empty() && value.front() == '/') {
    value.erase(value.begin());
  }
  while (!value.empty() && value.back() == '/') {
    value.pop_back();
  }
  return value;
}

std::string now_utc_iso8601() {
  std::time_t now = std::time(nullptr);
  std::tm tm{};
  gmtime_r(&now, &tm);

  char buffer[32];
  std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &tm);
  return buffer;
}

void sleep_until_done(
    std::chrono::milliseconds duration,
    const std::atomic_bool& cancel_requested,
    const std::atomic_bool& stop_requested) {
  const auto deadline = std::chrono::steady_clock::now() + duration;

  while (std::chrono::steady_clock::now() < deadline) {
    if (cancel_requested.load() || stop_requested.load()) {
      return;
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
}

void check_sdk_result(int32_t ret, const std::string& action) {
  if (ret != 0) {
    throw std::runtime_error(action + " failed, ret=" + std::to_string(ret));
  }
}

class RobotAdapter {
 public:
  virtual ~RobotAdapter() = default;
  virtual std::string sdk_name() const = 0;
  virtual void execute(
      const std::string& command_id,
      const CommandSpec& spec,
      std::atomic_bool& cancel_requested,
      std::atomic_bool& stop_requested) = 0;
  virtual void stop() = 0;
};

class DryRunAdapter final : public RobotAdapter {
 public:
  std::string sdk_name() const override { return "dry-run-cpp"; }

  void execute(
      const std::string& command_id,
      const CommandSpec& spec,
      std::atomic_bool& cancel_requested,
      std::atomic_bool& stop_requested) override {
    if (command_id == "stop") {
      return;
    }

    if (spec.duration.has_value()) {
      sleep_until_done(*spec.duration, cancel_requested, stop_requested);
    } else {
      sleep_until_done(std::chrono::milliseconds(500), cancel_requested, stop_requested);
    }
  }

  void stop() override {}
};

#if UNITREE_WITH_SDK
class R1Adapter final : public RobotAdapter {
 public:
  explicit R1Adapter(const std::string& network_interface) {
    unitree::robot::ChannelFactory::Instance()->Init(0, network_interface);
    client_.SetTimeout(10.0f);
    client_.Init();
  }

  std::string sdk_name() const override {
    return "unitree::robot::g1::LocoClient";
  }

  void execute(
      const std::string& command_id,
      const CommandSpec& spec,
      std::atomic_bool& cancel_requested,
      std::atomic_bool& stop_requested) override {
    if (spec.velocity.has_value() && spec.duration.has_value()) {
      const auto velocity = *spec.velocity;
      const float duration_seconds =
          static_cast<float>(spec.duration->count()) / 1000.0f;
      check_sdk_result(
          client_.SetVelocity(
              velocity.vx,
              velocity.vy,
              velocity.vyaw,
              duration_seconds),
          "R1 SetVelocity");
      sleep_until_done(*spec.duration, cancel_requested, stop_requested);
      check_sdk_result(client_.StopMove(), "R1 StopMove");
      return;
    }

    if (command_id == "shake_hand") {
      check_sdk_result(client_.ShakeHand(0), "R1 ShakeHand start");
      sleep_until_done(
          std::chrono::seconds(10),
          cancel_requested,
          stop_requested);
      check_sdk_result(client_.ShakeHand(1), "R1 ShakeHand stop");
      return;
    }
    if (command_id == "stand_up") {
      check_sdk_result(client_.StandUp(), "R1 StandUp");
      return;
    }
    if (command_id == "stand_down") {
      check_sdk_result(client_.Squat(), "R1 Squat");
      return;
    }
    if (command_id == "celebrate") {
      check_sdk_result(client_.WaveHand(true), "R1 WaveHand turn");
      return;
    }
    if (command_id == "wave_hand") {
      check_sdk_result(client_.WaveHand(false), "R1 WaveHand");
      return;
    }
    if (command_id == "stop") {
      stop();
      return;
    }

    throw std::runtime_error("R1 command is not mapped safely: " + command_id);
  }

  void stop() override { check_sdk_result(client_.StopMove(), "R1 StopMove"); }

 private:
  unitree::robot::g1::LocoClient client_;
};

class Go2Adapter final : public RobotAdapter {
 public:
  explicit Go2Adapter(const std::string& network_interface) {
    unitree::robot::ChannelFactory::Instance()->Init(0, network_interface);
    client_.SetTimeout(10.0f);
    client_.Init();
  }

  std::string sdk_name() const override {
    return "unitree::robot::go2::SportClient";
  }

  void execute(
      const std::string& command_id,
      const CommandSpec& spec,
      std::atomic_bool& cancel_requested,
      std::atomic_bool& stop_requested) override {
    if (spec.velocity.has_value() && spec.duration.has_value()) {
      const auto velocity = *spec.velocity;
      check_sdk_result(
          client_.Move(velocity.vx, velocity.vy, velocity.vyaw),
          "Go2 Move");
      sleep_until_done(*spec.duration, cancel_requested, stop_requested);
      check_sdk_result(client_.StopMove(), "Go2 StopMove");
      return;
    }

    if (command_id == "shake_hand") {
      check_sdk_result(client_.Hello(), "Go2 Hello");
      return;
    }
    if (command_id == "stand_up") {
      check_sdk_result(client_.StandUp(), "Go2 StandUp");
      return;
    }
    if (command_id == "stand_down") {
      check_sdk_result(client_.StandDown(), "Go2 StandDown");
      return;
    }
    if (command_id == "heart") {
      check_sdk_result(client_.Heart(), "Go2 Heart");
      return;
    }
    if (command_id == "celebrate") {
      check_sdk_result(client_.Dance1(), "Go2 Dance1");
      return;
    }
    if (command_id == "wave_hand") {
      check_sdk_result(client_.Hello(), "Go2 Hello");
      return;
    }
    if (command_id == "front_handstand") {
      check_sdk_result(client_.HandStand(true), "Go2 HandStand");
      return;
    }
    if (command_id == "rear_upright") {
      check_sdk_result(client_.WalkUpright(true), "Go2 WalkUpright");
      return;
    }
    if (command_id == "stop") {
      stop();
      return;
    }

    throw std::runtime_error("Go2 command is not mapped safely: " + command_id);
  }

  void stop() override { check_sdk_result(client_.StopMove(), "Go2 StopMove"); }

 private:
  unitree::robot::go2::SportClient client_;
};
#endif

std::unique_ptr<RobotAdapter> make_adapter(const Args& args) {
  if (args.dry_run) {
    return std::make_unique<DryRunAdapter>();
  }

#if UNITREE_WITH_SDK
  if (args.robot == "r1") {
    return std::make_unique<R1Adapter>(args.network_interface);
  }

  return std::make_unique<Go2Adapter>(args.network_interface);
#else
  throw std::runtime_error(
      "This binary was built with UNITREE_WITH_SDK=OFF. Use --dry-run or rebuild with SDK2.");
#endif
}

struct QueuedCommand {
  std::string command_id;
  json payload;
};

class Bridge {
 public:
  Bridge(Args args, std::unique_ptr<RobotAdapter> adapter)
      : args_(std::move(args)), adapter_(std::move(adapter)) {
    base_topic_ = trim_slashes(args_.topic_prefix) + "/" + args_.robot;
    command_topic_ = base_topic_ + "/command";
    robot_status_topic_ = base_topic_ + "/robot/status";
    web_status_topic_ = base_topic_ + "/web/status";
  }

  ~Bridge() {
    stop();
    if (client_ != nullptr) {
      MQTTClient_destroy(&client_);
    }
  }

  void run() {
    int rc = MQTTClient_create(
        &client_,
        args_.broker_url.c_str(),
        args_.client_id.c_str(),
        MQTTCLIENT_PERSISTENCE_NONE,
        nullptr);
    if (rc != MQTTCLIENT_SUCCESS) {
      throw std::runtime_error("MQTTClient_create failed: " + std::to_string(rc));
    }

    MQTTClient_setCallbacks(
        client_,
        this,
        &Bridge::on_connection_lost,
        &Bridge::on_message_arrived,
        &Bridge::on_delivery_complete);
    MQTTClient_setConnected(client_, this, &Bridge::on_connected);

    MQTTClient_willOptions will_options = MQTTClient_willOptions_initializer;
    const std::string will_payload =
        status_payload(false, "offline", "Jetson C++ bridge offline", nullptr)
            .dump();
    will_options.topicName = robot_status_topic_.c_str();
    will_options.message = will_payload.c_str();
    will_options.qos = 0;
    will_options.retained = 1;

    MQTTClient_SSLOptions ssl_options = MQTTClient_SSLOptions_initializer;
    ssl_options.enableServerCertAuth = args_.insecure_tls ? 0 : 1;

    MQTTClient_connectOptions connect_options =
        MQTTClient_connectOptions_initializer;
    connect_options.keepAliveInterval = 60;
    connect_options.cleansession = 1;
    connect_options.reliable = 1;
    connect_options.MQTTVersion = MQTTVERSION_3_1_1;
    connect_options.automaticReconnect = 1;
    connect_options.minRetryInterval = 1;
    connect_options.maxRetryInterval = 30;
    connect_options.will = &will_options;

    if (args_.broker_url.rfind("ssl://", 0) == 0 ||
        args_.broker_url.rfind("mqtts://", 0) == 0 ||
        args_.broker_url.rfind("wss://", 0) == 0) {
      connect_options.ssl = &ssl_options;
    }

    worker_ = std::thread(&Bridge::worker_loop, this);

    rc = MQTTClient_connect(client_, &connect_options);
    if (rc != MQTTCLIENT_SUCCESS) {
      request_stop_.store(true);
      queue_cv_.notify_all();
      if (worker_.joinable()) {
        worker_.join();
      }
      throw std::runtime_error("MQTT connect failed: " + std::to_string(rc));
    }

    mqtt_connected_.store(true);
    subscribe_topics();
    {
      std::lock_guard<std::mutex> lock(state_mutex_);
      ready_ = true;
    }
    publish_status(true, "ready", "Robot sẵn sàng nhận lệnh", nullptr);

    std::cout << "MQTT broker: " << args_.broker_url << '\n'
              << "Command topic: " << command_topic_ << '\n'
              << "Robot status topic: " << robot_status_topic_ << '\n'
              << "Web status topic: " << web_status_topic_ << '\n'
              << "SDK: " << adapter_->sdk_name() << std::endl;

    while (!request_stop_.load()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }

    stop();
  }

  void stop() {
    request_stop_.store(true);
    cancel_current_.store(true);
    queue_cv_.notify_all();

    if (worker_.joinable()) {
      worker_.join();
    }

    if (!shutdown_published_.exchange(true) && client_ != nullptr &&
        MQTTClient_isConnected(client_)) {
      {
        std::lock_guard<std::mutex> lock(state_mutex_);
        ready_ = false;
        active_command_.reset();
        active_command_label_.reset();
      }
      publish_status(false, "offline", "Jetson C++ bridge dừng chương trình", nullptr);
      MQTTClient_disconnect(client_, 1000);
    }
  }

  std::atomic_bool& stop_flag() { return request_stop_; }

 private:
  static void on_connection_lost(void* context, char* cause) {
    auto* bridge = static_cast<Bridge*>(context);
    bridge->mqtt_connected_.store(false);
    std::cerr << "MQTT connection lost: " << (cause != nullptr ? cause : "")
              << std::endl;
  }

  static void on_delivery_complete(void*, MQTTClient_deliveryToken) {}

  static void on_connected(void* context, char*) {
    auto* bridge = static_cast<Bridge*>(context);
    bridge->mqtt_connected_.store(true);
    bridge->subscribe_topics();
    {
      std::lock_guard<std::mutex> lock(bridge->state_mutex_);
      bridge->ready_ = true;
    }
    bridge->publish_status(true, "ready", "MQTT đã kết nối lại", nullptr);
  }

  static int on_message_arrived(
      void* context,
      char* topic_name,
      int,
      MQTTClient_message* message) {
    auto* bridge = static_cast<Bridge*>(context);
    const std::string topic = topic_name != nullptr ? topic_name : "";
    const char* payload_data = static_cast<char*>(message->payload);
    const std::string body =
        payload_data != nullptr && message->payloadlen > 0
            ? std::string(
                  payload_data,
                  static_cast<std::size_t>(message->payloadlen))
            : "";

    bridge->handle_message(topic, body);

    MQTTClient_freeMessage(&message);
    MQTTClient_free(topic_name);
    return 1;
  }

  void subscribe_topics() {
    if (client_ == nullptr || !MQTTClient_isConnected(client_)) {
      return;
    }

    int rc = MQTTClient_subscribe(client_, command_topic_.c_str(), 0);
    if (rc != MQTTCLIENT_SUCCESS) {
      std::cerr << "Subscribe command topic failed: " << rc << std::endl;
    }

    rc = MQTTClient_subscribe(client_, web_status_topic_.c_str(), 0);
    if (rc != MQTTCLIENT_SUCCESS) {
      std::cerr << "Subscribe web status topic failed: " << rc << std::endl;
    }
  }

  void handle_message(const std::string& topic, const std::string& body) {
    json payload;

    try {
      payload = json::parse(body);
    } catch (const std::exception& error) {
      publish_status(true, "error", std::string("Payload MQTT không phải JSON: ") + error.what(), nullptr);
      return;
    }

    if (topic == web_status_topic_) {
      {
        std::lock_guard<std::mutex> lock(state_mutex_);
        web_connected_ = payload.value("connected", false);
      }
      publish_status(true, "ready", "Đã cập nhật trạng thái web app", nullptr);
      return;
    }

    if (topic != command_topic_) {
      return;
    }

    const std::string command_id = payload.value("command", "");
    if (command_id.empty()) {
      publish_status(true, "error", "Payload thiếu trường command", nullptr);
      return;
    }

    if (command_id == "stop") {
      cancel_current_.store(true);
    }

    {
      std::lock_guard<std::mutex> lock(queue_mutex_);
      command_queue_.push_back({command_id, payload});
    }
    queue_cv_.notify_one();
  }

  json status_payload(
      bool connected,
      const std::string& state,
      const std::string& message,
      const char* last_command) const {
    std::lock_guard<std::mutex> lock(state_mutex_);

    return {
        {"client", "jetson-cpp"},
        {"robot", args_.robot},
        {"connected", connected},
        {"ready", connected && ready_ && !active_command_.has_value()},
        {"state", state},
        {"activeCommand", active_command_.has_value() ? json(*active_command_) : json(nullptr)},
        {"activeCommandLabel", active_command_label_.has_value() ? json(*active_command_label_) : json(nullptr)},
        {"lastCommand", last_command != nullptr ? json(last_command) : json(nullptr)},
        {"message", message},
        {"sdk", adapter_->sdk_name()},
        {"webConnected", web_connected_},
        {"updatedAt", now_utc_iso8601()},
    };
  }

  void publish_status(
      bool connected,
      const std::string& state,
      const std::string& message,
      const char* last_command) {
    if (client_ == nullptr || !MQTTClient_isConnected(client_)) {
      return;
    }

    const std::string payload =
        status_payload(connected, state, message, last_command).dump();

    MQTTClient_message pubmsg = MQTTClient_message_initializer;
    pubmsg.payload = const_cast<char*>(payload.data());
    pubmsg.payloadlen = static_cast<int>(payload.size());
    pubmsg.qos = 0;
    pubmsg.retained = 1;

    MQTTClient_deliveryToken token = 0;
    const int rc =
        MQTTClient_publishMessage(client_, robot_status_topic_.c_str(), &pubmsg, &token);
    if (rc != MQTTCLIENT_SUCCESS) {
      std::cerr << "Publish status failed: " << rc << std::endl;
    }
  }

  void worker_loop() {
    while (!request_stop_.load()) {
      QueuedCommand item;
      {
        std::unique_lock<std::mutex> lock(queue_mutex_);
        queue_cv_.wait(lock, [&] {
          return request_stop_.load() || !command_queue_.empty();
        });

        if (request_stop_.load()) {
          break;
        }

        item = command_queue_.front();
        command_queue_.pop_front();
      }

      const auto spec_iter = kCommands.find(item.command_id);
      if (spec_iter == kCommands.end()) {
        publish_status(true, "error", "Lệnh không hợp lệ: " + item.command_id, item.command_id.c_str());
        continue;
      }

      const CommandSpec& spec = spec_iter->second;
      cancel_current_.store(false);
      {
        std::lock_guard<std::mutex> lock(state_mutex_);
        ready_ = false;
        active_command_ = item.command_id;
        active_command_label_ = spec.label;
      }

      publish_status(true, "executing", "Đang thực thi: " + spec.label, nullptr);

      try {
        adapter_->execute(
            item.command_id,
            spec,
            cancel_current_,
            request_stop_);
      } catch (const std::exception& error) {
        {
          std::lock_guard<std::mutex> lock(state_mutex_);
          ready_ = true;
          active_command_.reset();
          active_command_label_.reset();
        }
        publish_status(
            true,
            "error",
            std::string("Lỗi khi gửi lệnh SDK2: ") + error.what(),
            item.command_id.c_str());
        continue;
      }

      {
        std::lock_guard<std::mutex> lock(state_mutex_);
        ready_ = true;
        active_command_.reset();
        active_command_label_.reset();
      }

      publish_status(true, "ready", "Hoàn tất: " + spec.label, item.command_id.c_str());
    }
  }

  Args args_;
  std::unique_ptr<RobotAdapter> adapter_;
  MQTTClient client_ = nullptr;

  std::string base_topic_;
  std::string command_topic_;
  std::string robot_status_topic_;
  std::string web_status_topic_;

  std::thread worker_;
  std::atomic_bool request_stop_{false};
  std::atomic_bool cancel_current_{false};
  std::atomic_bool mqtt_connected_{false};
  std::atomic_bool shutdown_published_{false};

  mutable std::mutex state_mutex_;
  bool ready_ = false;
  bool web_connected_ = false;
  std::optional<std::string> active_command_;
  std::optional<std::string> active_command_label_;

  std::mutex queue_mutex_;
  std::condition_variable queue_cv_;
  std::deque<QueuedCommand> command_queue_;
};

}  // namespace

int main(int argc, char** argv) {
  try {
    Args args = parse_args(argc, argv);
    ensure_wifi_connected(args);
    auto adapter = make_adapter(args);
    Bridge bridge(std::move(args), std::move(adapter));

    g_stop_flag = &bridge.stop_flag();
    std::signal(SIGINT, handle_signal);
    std::signal(SIGTERM, handle_signal);

    bridge.run();
    g_stop_flag = nullptr;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Fatal: " << error.what() << "\n\n" << usage(argv[0]);
    return 1;
  }
}
