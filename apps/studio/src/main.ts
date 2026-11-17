import { VERSION } from '@granite/core';

const app = document.querySelector<HTMLDivElement>('#app');
if (app) {
  app.textContent = `Granite Studio ${VERSION}`;
}
