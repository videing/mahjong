/**
 * 麻将规则引擎（浏览器版）
 * 万 1-9(0-8) · 筒 1-9(9-17) · 条 1-9(18-26) · 东南西北中发白(27-33)
 */

const SUIT_NAMES = ['万', '筒', '条'];
const HONOR_NAMES = ['东', '南', '西', '北', '中', '发', '白'];

export const KINDS = 34;

export function kindName(k) {
  if (k >= 27) return HONOR_NAMES[k - 27];
  return ((k % 9) + 1) + SUIT_NAMES[Math.floor(k / 9)];
}

export function emptyCounts() {
  const c = new Array(KINDS).fill(0);
  return c;
}

export function countsFromTiles(tiles) {
  const c = emptyCounts();
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] >= 0) c[tiles[i]]++;
  }
  return c;
}

function checkMelds(c, need) {
  if (need === 0) {
    for (let i = 0; i < KINDS; i++) if (c[i] !== 0) return false;
    return true;
  }
  let i = 0;
  while (i < KINDS && c[i] === 0) i++;
  if (i === KINDS) return false;

  if (c[i] >= 3) {
    c[i] -= 3;
    if (checkMelds(c, need - 1)) {
      c[i] += 3;
      return true;
    }
    c[i] += 3;
  }

  if (i < 27 && i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
    c[i]--; c[i + 1]--; c[i + 2]--;
    if (checkMelds(c, need - 1)) {
      c[i]++; c[i + 1]++; c[i + 2]++;
      return true;
    }
    c[i]++; c[i + 1]++; c[i + 2]++;
  }
  return false;
}

export function canWinHand(counts, meldCount) {
  const need = 4 - meldCount;
  if (need < 0) return false;

  let total = 0;
  for (let i = 0; i < KINDS; i++) total += counts[i];
  if (total !== need * 3 + 2) return false;

  if (meldCount === 0 && total === 14) {
    let pairs = 0;
    let ok = true;
    for (let i = 0; i < KINDS; i++) {
      if (counts[i] === 0) continue;
      if (counts[i] === 2) pairs += 1;
      else if (counts[i] === 4) pairs += 2;
      else {
        ok = false;
        break;
      }
    }
    if (ok && pairs === 7) return true;
  }

  for (let j = 0; j < KINDS; j++) {
    if (counts[j] >= 2) {
      counts[j] -= 2;
      const ok = checkMelds(counts, need);
      counts[j] += 2;
      if (ok) return true;
    }
  }
  return false;
}

export function waitingTiles(counts, meldCount) {
  const res = [];
  for (let k = 0; k < KINDS; k++) {
    if (counts[k] >= 4) continue;
    counts[k]++;
    if (canWinHand(counts, meldCount)) res.push(k);
    counts[k]--;
  }
  return res;
}

export function makeWall() {
  const wall = [];
  for (let k = 0; k < KINDS; k++) {
    for (let i = 0; i < 4; i++) wall.push(k);
  }
  return wall;
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}
