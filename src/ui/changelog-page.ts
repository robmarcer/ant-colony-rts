import { changelogHtml } from './changelog-view.js';
import { APP_VERSION } from '../meta/changelog.js';

document.title = `Changelog v${APP_VERSION} — Ant Colony RTS`;
document.getElementById('content')!.innerHTML = changelogHtml();
