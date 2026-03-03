import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-Hant',
  title: 'Pingora-s3-proxy 讀碼筆記',
  description: 'pingora-s3-proxy / pingora-s3-mongo 研究記錄',
  base: '/Pingora_reading/',
  themeConfig: {
    nav: [
      { text: '首頁', link: '/' },
      { text: '讀碼計畫', link: '/reading-plan' },
      { text: 'pingora-s3-mongo', link: '/s3-mongo/overview' },
      { text: '更新日誌', link: '/changelog' }
    ],
    sidebar: [
      {
        text: '導覽',
        items: [
          { text: '首頁', link: '/' },
          { text: '讀碼計畫', link: '/reading-plan' },
          { text: '更新日誌', link: '/changelog' }
        ]
      },
      {
        text: 'pingora-s3-mongo',
        items: [
          { text: '總覽', link: '/s3-mongo/overview' },
          { text: '啟動流程（main）', link: '/s3-mongo/bootstrap' },
          { text: 'Config（env 覆蓋）', link: '/s3-mongo/config' },
          { text: 'Auth（SigV4）', link: '/s3-mongo/auth' },
          { text: 'Mongo Store（資料模型）', link: '/s3-mongo/store' }
        ]
      }
    ]
  }
})
