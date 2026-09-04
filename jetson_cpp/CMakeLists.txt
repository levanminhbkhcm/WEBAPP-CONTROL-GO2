cmake_minimum_required(VERSION 3.16)

project(unitree_mqtt_bridge_cpp VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(UNITREE_WITH_SDK "Build with Unitree SDK2 high-level clients" ON)

find_package(Threads REQUIRED)
find_package(nlohmann_json 3.7.0 REQUIRED)

find_path(PAHO_MQTT_INCLUDE_DIR NAMES MQTTClient.h REQUIRED)
find_library(PAHO_MQTT_C_LIB NAMES paho-mqtt3cs REQUIRED)

add_executable(unitree_mqtt_bridge src/main.cpp)

target_include_directories(unitree_mqtt_bridge
  PRIVATE
    ${PAHO_MQTT_INCLUDE_DIR}
)

target_link_libraries(unitree_mqtt_bridge
  PRIVATE
    ${PAHO_MQTT_C_LIB}
    nlohmann_json::nlohmann_json
    Threads::Threads
)

if(UNITREE_WITH_SDK)
  find_package(unitree_sdk2 REQUIRED)
  target_compile_definitions(unitree_mqtt_bridge PRIVATE UNITREE_WITH_SDK=1)
  target_link_libraries(unitree_mqtt_bridge PRIVATE unitree_sdk2)
else()
  target_compile_definitions(unitree_mqtt_bridge PRIVATE UNITREE_WITH_SDK=0)
endif()

install(TARGETS unitree_mqtt_bridge RUNTIME DESTINATION bin)
