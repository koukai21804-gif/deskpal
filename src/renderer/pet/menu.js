// 宠物右键菜单（主进程 Menu.popup 保证层级）
import { dp } from '../common/ipc.js';

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  dp.petMenu();
});
