export const PROJECT = {
  name: 'vps-bot-multi',
  tagline: 'Describe it. Deploy it. For everyone.',
  version: '1.0.0',
  author: 'maksymhs',
  repo: 'https://github.com/maksymhs/vps-bot-multi',
  description: 'Multi-user AI-powered deploy platform — public Telegram bot, auto-sleep, per-user limits',
}

export function getBanner() {
  return `
                       __          __                  ____  _ 
  _   ______  _____   / /_  ____  / /_   __ _  __ __  / / /_(_)
  | | / / __ \\/ ___/  / __ \\/ __ \\/ __/  /  ' \\/ // / / / __/ /
  | |/ / /_/ (__  )  / /_/ / /_/ / /_   /_/_/_/\\_,_/ /_/\\__/_/ 
  |___/ .___/____/  /_.___/\\____/\\__/                          
     /_/          by maksymhs         
`
}

export function getSmallBanner() {
  return `vps-bot-multi v${PROJECT.version}`
}
