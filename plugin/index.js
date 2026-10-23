// 根入口：opencode v2 的插件 loader 按**目录**解析，取该目录的默认导出。
// 实测：入口放在子目录（package.json 的 main 指向 src/index.js）时**不会被加载**，
// 必须在目录根有一个入口文件。这里只做转发，实现全在 src/ 下。
export { default } from './src/index.js'
