export const PROJECT = {
  name: 'vps-bot',
  tagline: 'Describe it. Deploy it.',
  version: '1.0.0',
  author: 'maksymhs',
  repo: 'https://github.com/maksymhs/vps-bot',
  description: 'AI-powered VPS platform — describe an app, get it running with Docker + SSL in minutes',
}

export function getBanner() {
  return `
                       __          __ 
  _   ______  _____   / /_  ____  / /_
  | | / / __ \\/ ___/  / __ \\/ __ \\/ __/
  | |/ / /_/ (__  )  / /_/ / /_/ / /_ 
  |___/ .___/____/  /_.___/\\____/\\__/ 
     /_/          by maksymhs         
`
}

export function getSmallBanner() {
  return `vps-bot v${PROJECT.version}`
}
