'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  CheckCircle2,
  CircleStop,
  Clock3,
  Handshake,
  Heart,
  Loader2,
  Mic,
  PartyPopper,
  Play,
  Power,
  RefreshCw,
  Send,
  ShieldAlert,
  Signal,
  Square,
  UserRound,
  Wifi,
  WifiOff,
} from 'lucide-react';
import mqtt, { type MqttClient } from 'mqtt';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type RobotType = 'r1' | 'go2';
type MqttConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'error';

type RobotSdkBinding = {
  method: string;
  supported: boolean;
  note?: string;
};

type RobotCommand = {
  id: string;
  label: string;
  shortLabel: string;
  group: 'move' | 'pose' | 'gesture' | 'safety';
  durationMs?: number;
  velocity?: {
    vx: number;
    vy: number;
    vyaw: number;
  };
  keywords: string[];
  sdk: Record<RobotType, RobotSdkBinding>;
};

type RobotStatus = {
  connected: boolean;
  ready: boolean;
  state: string;
  activeCommand: string | null;
  activeCommandLabel: string | null;
  lastCommand: string | null;
  message: string;
  sdk: string;
  webConnected?: boolean;
  updatedAt?: string;
};

type LogItem = {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  time: string;
};

type SpeechRecognitionAlternativeLike = {
  transcript: string;
  confidence: number;
};

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
};

type SpeechRecognitionResultListLike = {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
};

type SpeechRecognitionEventLike = Event & {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
};

type SpeechRecognitionErrorEventLike = Event & {
  error?: string;
  message?: string;
};

type BrowserSpeechRecognition = EventTarget & {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const DEFAULT_BROKER_URL = 'wss://broker.emqx.io:8084/mqtt';
const DEFAULT_TOPIC_PREFIX = 'unitree/cdvd';

const ROBOTS: Array<{
  id: RobotType;
  label: string;
  description: string;
}> = [
  {
    id: 'r1',
    label: 'R1',
    description: 'SDK2 LocoClient, ưu tiên thử nghiệm hiện tại',
  },
  {
    id: 'go2',
    label: 'Go2',
    description: 'SDK2 SportClient cho robot Go2',
  },
];

const COMMANDS: RobotCommand[] = [
  {
    id: 'forward_4s',
    label: 'Đi tới',
    shortLabel: 'Tới',
    group: 'move',
    durationMs: 4000,
    velocity: { vx: 0.3, vy: 0, vyaw: 0 },
    keywords: ['đi tới', 'tiến lên', 'tiến tới', 'đi thẳng', 'đi lên'],
    sdk: {
      r1: {
        method: 'LocoClient.SetVelocity(0.3, 0, 0, 4)',
        supported: true,
      },
      go2: {
        method: 'SportClient.Move(0.3, 0, 0) + StopMove() sau 4s',
        supported: true,
      },
    },
  },
  {
    id: 'backward_4s',
    label: 'Đi lùi',
    shortLabel: 'Lùi',
    group: 'move',
    durationMs: 4000,
    velocity: { vx: -0.3, vy: 0, vyaw: 0 },
    keywords: ['đi lùi', 'lùi lại', 'lùi về sau', 'đi về sau'],
    sdk: {
      r1: {
        method: 'LocoClient.SetVelocity(-0.3, 0, 0, 4)',
        supported: true,
      },
      go2: {
        method: 'SportClient.Move(-0.3, 0, 0) + StopMove() sau 4s',
        supported: true,
      },
    },
  },
  {
    id: 'left_2s',
    label: 'Đi ngang trái',
    shortLabel: 'Trái',
    group: 'move',
    durationMs: 2000,
    velocity: { vx: 0, vy: 0.25, vyaw: 0 },
    keywords: ['đi ngang trái', 'sang trái', 'qua trái', 'dịch trái'],
    sdk: {
      r1: {
        method: 'LocoClient.SetVelocity(0, 0.25, 0, 2)',
        supported: true,
      },
      go2: {
        method: 'SportClient.Move(0, 0.25, 0) + StopMove() sau 2s',
        supported: true,
      },
    },
  },
  {
    id: 'right_2s',
    label: 'Đi ngang phải',
    shortLabel: 'Phải',
    group: 'move',
    durationMs: 2000,
    velocity: { vx: 0, vy: -0.25, vyaw: 0 },
    keywords: ['đi ngang phải', 'sang phải', 'qua phải', 'dịch phải'],
    sdk: {
      r1: {
        method: 'LocoClient.SetVelocity(0, -0.25, 0, 2)',
        supported: true,
      },
      go2: {
        method: 'SportClient.Move(0, -0.25, 0) + StopMove() sau 2s',
        supported: true,
      },
    },
  },
  {
    id: 'shake_hand',
    label: 'Bắt tay',
    shortLabel: 'Bắt tay',
    group: 'gesture',
    keywords: ['bắt tay', 'shake hand', 'chào bằng tay'],
    sdk: {
      r1: {
        method: 'LocoClient.ShakeHand(0) + ShakeHand(1)',
        supported: true,
      },
      go2: {
        method: 'SportClient.Hello()',
        supported: true,
        note: 'Go2 dùng Hello() cho hành vi chào/bắt tay',
      },
    },
  },
  {
    id: 'stand_up',
    label: 'Stand Up',
    shortLabel: 'Đứng lên',
    group: 'pose',
    keywords: ['stand up', 'đứng lên', 'đứng dậy', 'dựng lên'],
    sdk: {
      r1: {
        method: 'LocoClient.StandUp()',
        supported: true,
      },
      go2: {
        method: 'SportClient.StandUp()',
        supported: true,
      },
    },
  },
  {
    id: 'stand_down',
    label: 'Stand Down',
    shortLabel: 'Hạ xuống',
    group: 'pose',
    keywords: ['stand down', 'hạ xuống', 'ngồi xuống', 'nằm xuống'],
    sdk: {
      r1: {
        method: 'LocoClient.Squat()',
        supported: true,
      },
      go2: {
        method: 'SportClient.StandDown()',
        supported: true,
      },
    },
  },
  {
    id: 'heart',
    label: 'Vẽ trái tim',
    shortLabel: 'Trái tim',
    group: 'gesture',
    keywords: ['vẽ trái tim', 'trái tim', 'heart'],
    sdk: {
      r1: {
        method: 'Không có mapping an toàn trong R1 LocoClient',
        supported: false,
        note: 'R1 chưa có lệnh trái tim tương đương trong adapter hiện tại',
      },
      go2: {
        method: 'SportClient.Heart()',
        supported: true,
      },
    },
  },
  {
    id: 'celebrate',
    label: 'Vui mừng',
    shortLabel: 'Vui mừng',
    group: 'gesture',
    keywords: ['vui mừng', 'ăn mừng', 'nhảy vui', 'celebrate'],
    sdk: {
      r1: {
        method: 'LocoClient.WaveHand(True) + WaveHand(False)',
        supported: true,
      },
      go2: {
        method: 'SportClient.Dance1()',
        supported: true,
      },
    },
  },
  {
    id: 'wave_hand',
    label: 'Vẫy tay',
    shortLabel: 'Vẫy tay',
    group: 'gesture',
    keywords: ['vẫy tay', 'chào tay', 'wave hand'],
    sdk: {
      r1: {
        method: 'LocoClient.WaveHand(True) + WaveHand(False)',
        supported: true,
      },
      go2: {
        method: 'SportClient.Hello()',
        supported: true,
      },
    },
  },
  {
    id: 'front_handstand',
    label: 'Đứng 2 chân trước',
    shortLabel: '2 chân trước',
    group: 'pose',
    keywords: [
      'đứng bằng hai chân trước',
      'đứng bằng 2 chân trước',
      'hai chân trước',
      'handstand',
    ],
    sdk: {
      r1: {
        method: 'Không hỗ trợ cho R1 trong adapter hiện tại',
        supported: false,
      },
      go2: {
        method: 'SportClient.HandStand(True)',
        supported: true,
      },
    },
  },
  {
    id: 'rear_upright',
    label: 'Đứng 2 chân sau',
    shortLabel: '2 chân sau',
    group: 'pose',
    keywords: [
      'đứng bằng hai chân sau',
      'đứng bằng 2 chân sau',
      'hai chân sau',
      'walk upright',
    ],
    sdk: {
      r1: {
        method: 'Không hỗ trợ cho R1 trong adapter hiện tại',
        supported: false,
      },
      go2: {
        method: 'SportClient.WalkUpright(True)',
        supported: true,
      },
    },
  },
  {
    id: 'stop',
    label: 'Dừng',
    shortLabel: 'Dừng',
    group: 'safety',
    keywords: ['dừng', 'dừng lại', 'stop', 'ngừng', 'khẩn cấp'],
    sdk: {
      r1: {
        method: 'LocoClient.StopMove()',
        supported: true,
      },
      go2: {
        method: 'SportClient.StopMove()',
        supported: true,
      },
    },
  },
];

const MEMBERS = [
  'Nguyễn Văn A',
  'Nguyễn Văn B',
  'Nguyễn Văn C',
  'Nguyễn Văn D',
  'Nguyễn Văn E',
];

const EMPTY_ROBOT_STATUS: RobotStatus = {
  connected: false,
  ready: false,
  state: 'offline',
  activeCommand: null,
  activeCommandLabel: null,
  lastCommand: null,
  message: 'Chưa nhận trạng thái từ robot',
  sdk: 'Chưa xác định',
};

const ICONS: Record<RobotCommand['id'], typeof ArrowUp> = {
  forward_4s: ArrowUp,
  backward_4s: ArrowDown,
  left_2s: ArrowLeft,
  right_2s: ArrowRight,
  shake_hand: Handshake,
  stand_up: Play,
  stand_down: Square,
  heart: Heart,
  celebrate: PartyPopper,
  wave_hand: UserRound,
  front_handstand: ArrowUp,
  rear_upright: ArrowUp,
  stop: CircleStop,
};

function normalizeVietnamese(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectCommand(text: string) {
  const normalizedText = normalizeVietnamese(text);

  if (!normalizedText) {
    return null;
  }

  for (const command of COMMANDS) {
    const matchedKeyword = command.keywords.find((keyword) =>
      normalizedText.includes(normalizeVietnamese(keyword)),
    );

    if (matchedKeyword) {
      return { command, matchedKeyword };
    }
  }

  return null;
}

function statusLabel(state: MqttConnectionState) {
  switch (state) {
    case 'connected':
      return 'Đã kết nối MQTT';
    case 'connecting':
      return 'Đang kết nối MQTT';
    case 'reconnecting':
      return 'Đang kết nối lại';
    case 'error':
      return 'Lỗi MQTT';
    default:
      return 'Chưa kết nối MQTT';
  }
}

function formatDuration(durationMs?: number) {
  if (!durationMs) {
    return null;
  }

  return `${durationMs / 1000}s`;
}

function nowTime() {
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date());
}

function makeStatusPayload(
  connected: boolean,
  robot: RobotType,
  baseTopic: string,
) {
  return JSON.stringify({
    client: 'web',
    connected,
    robot,
    ready: connected,
    state: connected ? 'online' : 'offline',
    baseTopic,
    updatedAt: new Date().toISOString(),
  });
}

export default function Home() {
  const [selectedRobot, setSelectedRobot] = useState<RobotType>('r1');
  const [brokerInput, setBrokerInput] = useState(DEFAULT_BROKER_URL);
  const [topicPrefixInput, setTopicPrefixInput] =
    useState(DEFAULT_TOPIC_PREFIX);
  const [connectionConfig, setConnectionConfig] = useState({
    brokerUrl: DEFAULT_BROKER_URL,
    topicPrefix: DEFAULT_TOPIC_PREFIX,
  });
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [mqttState, setMqttState] = useState<MqttConnectionState>('connecting');
  const [mqttError, setMqttError] = useState('');
  const [robotStatus, setRobotStatus] =
    useState<RobotStatus>(EMPTY_ROBOT_STATUS);
  const [lastSentCommand, setLastSentCommand] = useState<RobotCommand | null>(
    null,
  );
  const [textCommand, setTextCommand] = useState('');
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [detectedVoiceCommand, setDetectedVoiceCommand] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const [webSpeechSupported, setWebSpeechSupported] = useState(false);
  const [logs, setLogs] = useState<LogItem[]>([]);

  const mqttClientRef = useRef<MqttClient | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const finalTranscriptRef = useRef('');

  const activeRobot = ROBOTS.find((robot) => robot.id === selectedRobot);
  const baseTopic = useMemo(() => {
    const prefix =
      connectionConfig.topicPrefix.trim().replace(/^\/+|\/+$/g, '') ||
      DEFAULT_TOPIC_PREFIX;

    return `${prefix}/${selectedRobot}`;
  }, [connectionConfig.topicPrefix, selectedRobot]);

  const topics = useMemo(
    () => ({
      command: `${baseTopic}/command`,
      robotStatus: `${baseTopic}/robot/status`,
      webStatus: `${baseTopic}/web/status`,
    }),
    [baseTopic],
  );

  const addLog = useCallback(
    (level: LogItem['level'], message: string) => {
      setLogs((current) =>
        [
          {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            level,
            message,
            time: nowTime(),
          },
          ...current,
        ].slice(0, 8),
      );
    },
    [setLogs],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setWebSpeechSupported(
        Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
      );
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let disposed = false;
    const clientId = `cdvd-web-${selectedRobot}-${Math.random()
      .toString(16)
      .slice(2)}`;
    const client = mqtt.connect(connectionConfig.brokerUrl, {
      clean: true,
      clientId,
      connectTimeout: 30000,
      keepalive: 60,
      reconnectPeriod: 1000,
      will: {
        topic: topics.webStatus,
        payload: makeStatusPayload(false, selectedRobot, baseTopic),
        qos: 0,
        retain: true,
      },
    });

    mqttClientRef.current = client;

    client.on('connect', () => {
      if (disposed) {
        return;
      }

      setMqttState('connected');
      setMqttError('');
      client.subscribe(topics.robotStatus, { qos: 0 });
      client.publish(
        topics.webStatus,
        makeStatusPayload(true, selectedRobot, baseTopic),
        {
          qos: 0,
          retain: true,
        },
      );
      addLog('success', `Web đã online: ${topics.webStatus}`);
    });

    client.on('reconnect', () => {
      if (disposed) {
        return;
      }

      setMqttState('reconnecting');
    });

    client.on('offline', () => {
      if (disposed) {
        return;
      }

      setMqttState('offline');
    });

    client.on('close', () => {
      if (disposed) {
        return;
      }

      setMqttState((current) =>
        current === 'connected' ? 'offline' : current,
      );
    });

    client.on('error', (error) => {
      if (disposed) {
        return;
      }

      setMqttState('error');
      setMqttError(error.message);
    });

    client.on('message', (topic, payload) => {
      if (disposed) {
        return;
      }

      if (topic !== topics.robotStatus) {
        return;
      }

      try {
        const parsed = JSON.parse(payload.toString()) as Partial<RobotStatus>;
        setRobotStatus({
          ...EMPTY_ROBOT_STATUS,
          ...parsed,
          connected: Boolean(parsed.connected),
          ready: Boolean(parsed.ready),
          activeCommand: parsed.activeCommand ?? null,
          activeCommandLabel: parsed.activeCommandLabel ?? null,
          lastCommand: parsed.lastCommand ?? null,
          message: parsed.message ?? EMPTY_ROBOT_STATUS.message,
          sdk: parsed.sdk ?? EMPTY_ROBOT_STATUS.sdk,
        });
      } catch {
        addLog('warning', 'Không đọc được payload trạng thái robot');
      }
    });

    return () => {
      disposed = true;
      client.publish(
        topics.webStatus,
        makeStatusPayload(false, selectedRobot, baseTopic),
        { qos: 0, retain: true },
      );
      client.end(true);

      if (mqttClientRef.current === client) {
        mqttClientRef.current = null;
      }
    };
  }, [
    addLog,
    baseTopic,
    connectionConfig.brokerUrl,
    connectionVersion,
    selectedRobot,
    topics.robotStatus,
    topics.webStatus,
  ]);

  useEffect(() => {
    if (!recording) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      setRecordingSeconds((current) => current + 1);
    }, 1000);

    return () => window.clearInterval(interval);
  }, [recording]);

  const publishCommand = useCallback(
    (
      command: RobotCommand,
      source: 'panel' | 'voice' | 'text',
      rawText?: string,
    ) => {
      const binding = command.sdk[selectedRobot];

      if (!binding.supported) {
        addLog(
          'warning',
          `${command.label} chưa có mapping an toàn cho ${selectedRobot.toUpperCase()}`,
        );
        return;
      }

      const client = mqttClientRef.current;

      if (!client?.connected) {
        addLog('error', 'Chưa kết nối MQTT, không thể gửi lệnh');
        return;
      }

      const payload = {
        id: `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        robot: selectedRobot,
        command: command.id,
        label: command.label,
        durationMs: command.durationMs ?? null,
        velocity: command.velocity ?? null,
        sdkMethod: binding.method,
        source,
        rawText: rawText ?? null,
        issuedAt: new Date().toISOString(),
      };

      client.publish(
        topics.command,
        JSON.stringify(payload),
        { qos: 0 },
        (error) => {
          if (error) {
            addLog('error', `Gửi lệnh thất bại: ${error.message}`);
            return;
          }

          setLastSentCommand(command);
          addLog('success', `Đã gửi lệnh: ${command.label}`);
        },
      );
    },
    [addLog, selectedRobot, topics.command],
  );

  const handleTextCommand = useCallback(() => {
    const detected = detectCommand(textCommand);

    if (!detected) {
      addLog('warning', 'Không phát hiện lệnh điều khiển trong text');
      return;
    }

    setDetectedVoiceCommand(detected.command.label);
    publishCommand(detected.command, 'text', textCommand);
  }, [addLog, publishCommand, textCommand]);

  const handleStartRecording = useCallback(() => {
    setVoiceError('');
    setDetectedVoiceCommand('');
    setInterimTranscript('');
    setTranscript('');
    finalTranscriptRef.current = '';

    const Recognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!Recognition) {
      setVoiceError(
        'Trình duyệt chưa hỗ trợ Web Speech API. Hãy dùng Chrome hoặc Edge.',
      );
      return;
    }

    const recognition = new Recognition();
    recognition.lang = 'vi-VN';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let finalText = finalTranscriptRef.current;
      let interimText = '';

      for (
        let index = event.resultIndex;
        index < event.results.length;
        index += 1
      ) {
        const result = event.results[index];
        const spokenText = result[0]?.transcript ?? '';

        if (result.isFinal) {
          finalText = `${finalText} ${spokenText}`.trim();
        } else {
          interimText = `${interimText} ${spokenText}`.trim();
        }
      }

      finalTranscriptRef.current = finalText;
      setTranscript(finalText);
      setInterimTranscript(interimText);
    };

    recognition.onerror = (event) => {
      setVoiceError(event.message || event.error || 'Lỗi nhận diện giọng nói');
      setRecording(false);
    };

    recognition.onend = () => {
      setRecording(false);
      setInterimTranscript('');

      const spokenText = finalTranscriptRef.current.trim();
      setTranscript(spokenText);

      if (!spokenText) {
        return;
      }

      const detected = detectCommand(spokenText);

      if (!detected) {
        setDetectedVoiceCommand('Không phát hiện lệnh phù hợp');
        addLog('warning', 'Giọng nói không khớp lệnh điều khiển');
        return;
      }

      setDetectedVoiceCommand(
        `${detected.command.label} (${detected.matchedKeyword})`,
      );
      publishCommand(detected.command, 'voice', spokenText);
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
      setRecording(true);
      addLog('info', 'Bắt đầu ghi âm tiếng Việt');
    } catch (error) {
      setVoiceError(
        error instanceof Error ? error.message : 'Không thể ghi âm',
      );
    }
  }, [addLog, publishCommand]);

  const handleStopRecording = useCallback(() => {
    recognitionRef.current?.stop();
    addLog('info', 'Đã dừng ghi âm');
  }, [addLog]);

  const reconnect = useCallback(() => {
    setMqttState('connecting');
    setMqttError('');
    setRobotStatus(EMPTY_ROBOT_STATUS);
    setLastSentCommand(null);
    addLog(
      'info',
      `Kết nối MQTT tới ${brokerInput.trim() || DEFAULT_BROKER_URL}`,
    );
    setConnectionConfig({
      brokerUrl: brokerInput.trim() || DEFAULT_BROKER_URL,
      topicPrefix: topicPrefixInput.trim() || DEFAULT_TOPIC_PREFIX,
    });
    setConnectionVersion((current) => current + 1);
  }, [addLog, brokerInput, topicPrefixInput]);

  const handleRobotChange = useCallback(
    (robot: RobotType) => {
      setSelectedRobot(robot);
      setMqttState('connecting');
      setMqttError('');
      setRobotStatus(EMPTY_ROBOT_STATUS);
      setLastSentCommand(null);
      addLog('info', `Chuyển sang robot ${robot.toUpperCase()}`);
    },
    [addLog],
  );

  const activeCommandLabel =
    robotStatus.activeCommandLabel || lastSentCommand?.label || 'Chưa có lệnh';
  const mqttConnected = mqttState === 'connected';
  const selectedRobotReady =
    mqttConnected && robotStatus.connected && robotStatus.ready;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b-2 border-slate-900 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-16 w-36 shrink-0 items-center justify-center rounded-[4px] border-2 border-slate-900 bg-emerald-50 text-center text-sm font-black leading-tight text-slate-950">
              Logo
              <br />
              Trường CĐVĐ
            </div>
            <div className="hidden h-12 w-12 items-center justify-center rounded-[6px] bg-slate-950 text-white md:flex">
              <Bot className="size-7" aria-hidden="true" />
            </div>
          </div>

          <div className="text-left md:text-center">
            <p className="text-xs font-bold uppercase text-emerald-700">
              Unitree SDK2 / MQTT
            </p>
            <h1 className="text-2xl font-black leading-tight text-slate-950 md:text-3xl">
              ỨNG DỤNG ĐIỀU KHIỂN ROBOT UNITREE TỪ XA
            </h1>
          </div>

          <Badge
            className={cn(
              'h-8 rounded-[6px] px-3',
              mqttConnected
                ? 'bg-emerald-600 text-white'
                : 'bg-amber-100 text-amber-900',
            )}
          >
            {mqttConnected ? (
              <Wifi className="size-3.5" aria-hidden="true" />
            ) : (
              <WifiOff className="size-3.5" aria-hidden="true" />
            )}
            {statusLabel(mqttState)}
          </Badge>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_290px]">
        <div className="space-y-4">
          <section className="rounded-[6px] border-2 border-slate-900 bg-white p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <label
                htmlFor="robot-select"
                className="text-lg font-black text-slate-950"
              >
                Lựa chọn Robot
              </label>
              <NativeSelect
                id="robot-select"
                value={selectedRobot}
                onChange={(event) =>
                  handleRobotChange(event.target.value as RobotType)
                }
                className="w-full md:w-56"
              >
                {ROBOTS.map((robot) => (
                  <NativeSelectOption key={robot.id} value={robot.id}>
                    {robot.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <span className="text-sm font-medium text-slate-600">
                {activeRobot?.description}
              </span>
            </div>
          </section>

          <section className="rounded-[6px] border-2 border-slate-900 bg-white p-4">
            <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <h2 className="text-xl font-black text-slate-950">
                Bảng điều khiển
              </h2>
              <div className="flex flex-wrap gap-2">
                <Badge
                  className={cn(
                    'rounded-[6px]',
                    selectedRobotReady
                      ? 'bg-emerald-100 text-emerald-900'
                      : 'bg-slate-100 text-slate-700',
                  )}
                >
                  <CheckCircle2 className="size-3.5" aria-hidden="true" />
                  {selectedRobotReady ? 'Sẵn sàng nhận lệnh' : 'Chờ robot'}
                </Badge>
                <Badge variant="outline" className="rounded-[6px]">
                  Topic: {topics.command}
                </Badge>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {COMMANDS.map((command) => {
                const Icon = ICONS[command.id];
                const binding = command.sdk[selectedRobot];
                const isActive = robotStatus.activeCommand === command.id;

                return (
                  <Button
                    key={command.id}
                    type="button"
                    variant={command.id === 'stop' ? 'destructive' : 'outline'}
                    className={cn(
                      'min-h-[58px] justify-start gap-2 rounded-[6px] border-2 border-slate-900 px-3 text-left text-base font-black whitespace-normal',
                      command.id !== 'stop' &&
                        'bg-white text-slate-950 hover:bg-cyan-50',
                      isActive && 'bg-emerald-100 text-emerald-950',
                    )}
                    disabled={!binding.supported}
                    title={binding.method}
                    onClick={() => publishCommand(command, 'panel')}
                  >
                    <Icon className="size-5 shrink-0" aria-hidden="true" />
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span>{command.label}</span>
                      <span className="text-xs font-semibold text-slate-500">
                        {formatDuration(command.durationMs) ??
                          (binding.supported
                            ? command.shortLabel
                            : 'Chưa hỗ trợ')}
                      </span>
                    </span>
                  </Button>
                );
              })}
            </div>
          </section>

          <section className="rounded-[6px] border-2 border-slate-900 bg-white p-4">
            <h2 className="mb-4 text-xl font-black text-slate-950">
              Điều khiển qua giọng nói
            </h2>

            <div className="grid gap-3 lg:grid-cols-[auto_minmax(220px,1fr)_auto]">
              <div className="flex gap-2">
                <Button
                  type="button"
                  className="h-12 rounded-[6px] border-2 border-slate-900 px-4 text-base font-black"
                  disabled={recording || !webSpeechSupported}
                  onClick={handleStartRecording}
                >
                  {recording ? (
                    <Loader2
                      className="size-5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Mic className="size-5" aria-hidden="true" />
                  )}
                  Bắt đầu ghi âm
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-12 rounded-[6px] border-2 border-slate-900 px-4 text-base font-black"
                  disabled={!recording}
                  onClick={handleStopRecording}
                >
                  <Square className="size-5" aria-hidden="true" />
                  Stop
                </Button>
              </div>

              <Input
                value={textCommand}
                onChange={(event) => setTextCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleTextCommand();
                  }
                }}
                placeholder="Nhập lệnh bằng text"
                className="h-12 rounded-[6px] border-2 border-slate-900 text-base font-semibold"
              />

              <Button
                type="button"
                className="h-12 rounded-[6px] border-2 border-slate-900 px-5 text-base font-black"
                onClick={handleTextCommand}
              >
                <Send className="size-5" aria-hidden="true" />
                Gửi lệnh
              </Button>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_240px]">
              <Textarea
                readOnly
                value={[
                  transcript || 'Dữ liệu ghi âm được / Dữ liệu nhận được',
                  interimTranscript,
                ]
                  .filter(Boolean)
                  .join('\n')}
                className="min-h-32 resize-none rounded-[6px] border-2 border-slate-900 text-base font-semibold"
              />
              <div className="rounded-[6px] border-2 border-slate-900 bg-slate-50 p-3">
                <div className="mb-3 flex items-center gap-2 text-sm font-black text-slate-950">
                  <Clock3 className="size-4" aria-hidden="true" />
                  {recording
                    ? `Đang ghi âm: ${recordingSeconds}s`
                    : 'Chưa ghi âm'}
                </div>
                <div className="space-y-2 text-sm text-slate-700">
                  <p>
                    <span className="font-black text-slate-950">
                      Lệnh phát hiện:
                    </span>{' '}
                    {detectedVoiceCommand || 'Chưa có'}
                  </p>
                  {voiceError ? (
                    <p className="font-semibold text-red-700">{voiceError}</p>
                  ) : null}
                  {!webSpeechSupported ? (
                    <p className="font-semibold text-amber-700">
                      Trình duyệt hiện tại chưa hỗ trợ nhận diện giọng nói.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-[6px] border-2 border-slate-900 bg-white p-4">
            <div className="mb-3 flex items-center gap-2">
              <Signal className="size-5 text-cyan-700" aria-hidden="true" />
              <h2 className="text-xl font-black text-slate-950">
                MQTT cấu hình
              </h2>
            </div>
            <div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_minmax(180px,280px)_auto]">
              <Input
                value={brokerInput}
                onChange={(event) => setBrokerInput(event.target.value)}
                className="h-10 rounded-[6px] border-2 border-slate-900"
                aria-label="MQTT broker URL"
              />
              <Input
                value={topicPrefixInput}
                onChange={(event) => setTopicPrefixInput(event.target.value)}
                className="h-10 rounded-[6px] border-2 border-slate-900"
                aria-label="MQTT topic prefix"
              />
              <Button
                type="button"
                variant="outline"
                className="h-10 rounded-[6px] border-2 border-slate-900 font-black"
                onClick={reconnect}
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                Kết nối lại
              </Button>
            </div>
            {mqttError ? (
              <p className="mt-2 text-sm font-semibold text-red-700">
                {mqttError}
              </p>
            ) : null}
          </section>
        </div>

        <aside className="space-y-4">
          <section className="rounded-[6px] border-2 border-slate-900 bg-white p-4">
            <h2 className="mb-2 text-lg font-black text-slate-950">
              Danh sách thành viên
            </h2>
            <ol className="space-y-1 pl-6 text-lg font-black text-slate-950">
              {MEMBERS.map((member) => (
                <li key={member}>{member}</li>
              ))}
            </ol>
          </section>

          <section className="min-h-[466px] rounded-[6px] border-2 border-slate-900 bg-white p-4">
            <h2 className="text-center text-lg font-black leading-tight text-slate-950">
              Trạng thái đọc
              <br />
              từ Robot
            </h2>

            <div
              className={cn(
                'mx-auto mt-4 flex min-h-14 w-full max-w-56 items-center justify-center rounded-[50%] border-2 px-4 text-center text-base font-black',
                mqttConnected
                  ? 'border-emerald-700 bg-emerald-50 text-emerald-900'
                  : 'border-slate-500 bg-slate-50 text-slate-600',
              )}
            >
              {statusLabel(mqttState)}
            </div>

            <div className="mt-5 space-y-3 text-sm font-semibold text-slate-700">
              <StatusRow
                icon={Power}
                label="Robot"
                value={robotStatus.connected ? 'Online' : 'Offline'}
                active={robotStatus.connected}
              />
              <StatusRow
                icon={CheckCircle2}
                label="Sẵn sàng"
                value={robotStatus.ready ? 'Có' : 'Không'}
                active={robotStatus.ready}
              />
              <StatusRow
                icon={Activity}
                label="SDK"
                value={robotStatus.sdk}
                active={robotStatus.connected}
              />
            </div>

            <div className="mt-8">
              <h3 className="text-center text-lg font-black text-slate-950">
                Đang thực thi lệnh
              </h3>
              <div className="mx-auto mt-4 flex min-h-16 w-full max-w-44 items-center justify-center rounded-[50%] border-2 border-slate-900 bg-cyan-50 px-4 text-center text-base font-black text-slate-950">
                {activeCommandLabel}
              </div>
            </div>

            <div className="mt-6 rounded-[6px] bg-slate-50 p-3 text-sm text-slate-700">
              <p className="font-black text-slate-950">Thông báo</p>
              <p className="mt-1">{robotStatus.message}</p>
            </div>
          </section>

          <section className="rounded-[6px] border-2 border-slate-900 bg-white p-4">
            <div className="mb-3 flex items-center gap-2">
              <ShieldAlert
                className="size-5 text-amber-700"
                aria-hidden="true"
              />
              <h2 className="text-lg font-black text-slate-950">Nhật ký</h2>
            </div>
            <div className="space-y-2">
              {logs.length ? (
                logs.map((log) => (
                  <div
                    key={log.id}
                    className={cn(
                      'rounded-[6px] border px-2 py-1.5 text-sm font-semibold',
                      log.level === 'success' &&
                        'border-emerald-200 bg-emerald-50 text-emerald-900',
                      log.level === 'warning' &&
                        'border-amber-200 bg-amber-50 text-amber-900',
                      log.level === 'error' &&
                        'border-red-200 bg-red-50 text-red-900',
                      log.level === 'info' &&
                        'border-slate-200 bg-slate-50 text-slate-700',
                    )}
                  >
                    <span className="mr-2 text-xs opacity-70">{log.time}</span>
                    {log.message}
                  </div>
                ))
              ) : (
                <p className="text-sm font-semibold text-slate-500">
                  Chưa có sự kiện.
                </p>
              )}
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}

function StatusRow({
  icon: Icon,
  label,
  value,
  active,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  active: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[6px] border border-slate-200 bg-slate-50 px-3 py-2">
      <span className="flex min-w-0 items-center gap-2">
        <Icon
          className={cn(
            'size-4 shrink-0',
            active ? 'text-emerald-700' : 'text-slate-400',
          )}
          aria-hidden="true"
        />
        <span className="text-slate-600">{label}</span>
      </span>
      <span className="min-w-0 truncate font-black text-slate-950">
        {value}
      </span>
    </div>
  );
}
