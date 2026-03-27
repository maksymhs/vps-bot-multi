import './globals.css'

export const metadata = {
  title: 'App',
  description: 'Powered by vps-bot',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 min-h-screen antialiased">
        {children}
      </body>
    </html>
  )
}
