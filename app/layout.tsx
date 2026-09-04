import './globals.css';

export const metadata = {
  title: 'Điều khiển Robot Unitree từ xa',
  description:
    'Web application điều khiển robot Unitree R1 và Go2 qua MQTT, SDK2 và nhận diện giọng nói tiếng Việt.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
