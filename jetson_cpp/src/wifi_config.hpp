#pragma once

namespace wifi_config {

// Sua 2 gia tri nay tren Jetson truoc khi build/cai dat service.
// Khong nen commit mat khau WiFi that len GitHub public.
inline constexpr bool kEnableWifiAutoConnect = true;
inline constexpr const char* kWifiSsid = "TEN_WIFI_CUA_BAN";
inline constexpr const char* kWifiPassword = "MAT_KHAU_WIFI_CUA_BAN";

// Interface WiFi thuong gap tren Jetson la wlan0. Kiem tra bang: ip link
inline constexpr const char* kWifiInterface = "wlan0";

// Bridge se cho toi da thoi gian nay de WiFi san sang truoc khi ket noi MQTT.
inline constexpr int kWifiConnectTimeoutSeconds = 45;

// Host dung de kiem tra DNS/internet sau khi WiFi connected.
inline constexpr const char* kConnectivityCheckHost = "broker.emqx.io";

}  // namespace wifi_config
