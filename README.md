# BLOCKSHOT

4v4 zászlórablós (CTF) voxel FPS böngészőben. A pálya két lépcsős torony egy lebegő aszteroidán az űrben. Ketten játszotok egymás ellen, és mindkettőtök csapatában 3 bot van. Egyedül is lehet gyakorolni: te + 3 bot a 4 bot ellen.

Játékszerver nincs: a két böngésző közvetlenül kapcsolódik egymáshoz (WebRTC, Trystero/Nostr).

A projektben van még négy játék:

- **HOMOKFUTAM**: 3D podverseny 2–6 játékosnak a `/homokfutam/` címen. Leírás: [homokfutam/README.md](homokfutam/README.md).
- **HADÚR**: valós idejű stratégia, emberek az orkok ellen, 1v1 (vagy a gép ellen) a `/hadur/` címen. Leírás: [hadur/README.md](hadur/README.md).
- **FÉNYKARD**: fénykardpárbaj 1v1, a telefonod giroszkópja a kard, a `/fenykard/` címen. Leírás: [fenykard/README.md](fenykard/README.md).
- **HÁGÓ**: képregényes MOBA, 2v2 (vagy 1v1) minionokkal, tornyokkal és egy őrrel a szurdokban, a `/hago/` címen. Leírás: [hago/README.md](hago/README.md).

**Játék online, telepítés nélkül:**

- BLOCKSHOT: https://volgyid-novin.github.io/bongeszos-jatekok/
- HOMOKFUTAM: https://volgyid-novin.github.io/bongeszos-jatekok/homokfutam/
- HADÚR: https://volgyid-novin.github.io/bongeszos-jatekok/hadur/
- FÉNYKARD: https://volgyid-novin.github.io/bongeszos-jatekok/fenykard/
- HÁGÓ: https://volgyid-novin.github.io/bongeszos-jatekok/hago/

Az oldalt a GitHub Pages szolgálja ki. Minden `main` ágra feltöltött változás után a `.github/workflows/pages.yml` újrabuildeli és kiteszi, pár perc alatt.

## Indítás

```bash
npm install
npm run dev
```

Utána nyisd meg: http://localhost:5173 (Chrome, Edge vagy Firefox, mert kell hozzá az egér befogása).

## Játék a haveroddal

Az oldalt **HTTPS-en** (vagy localhoston) kell megnyitni.

**A) Gyorsan, regisztráció nélkül (Cloudflare quick tunnel)**

```bash
npm run build
npm run preview
```

Egy másik terminálban:

```bash
npx cloudflared tunnel --url http://localhost:4173
```

Nyisd meg te is a kiírt `https://….trycloudflare.com` linket (ne a localhostot!), nyomj **ÚJ SZOBA**-t, és küldd el a meghívó linket. A host a piros, a vendég a kék csapat.

**B) Állandó link (ingyenes fiók kell)**

`npm run build` után a `dist` mappát töltsd fel Netlifyra, GitHub Pagesre vagy Cloudflare Pagesre.

## Irányítás

| Billentyű | Mit csinál |
|---|---|
| WASD / Space | mozgás / ugrás |
| Egér, bal klikk | célzás, lövés |
| Jobb klikk (mesterlövészpuskával) | távcső |
| R | újratöltés |
| 1–5 vagy görgő | fegyverváltás |
| Tab (nyomva) | eredménytábla |
| Esc | egér elengedése |

## Szabályok

- Hozd el az ellenfél zászlaját a tornyuk aljából, és érintsd meg vele a sajátodat. Csak akkor számít, ha a saját zászlótok otthon van. **3 zászló** nyer, vagy 10 perc után a több.
- Ha a zászlóvivő meghal, a zászló leesik. A saját csapata érintéssel visszaviszi, különben 20 mp után magától visszakerül. Ha a vivő lezuhan az aszteroidáról, a zászló azonnal hazakerül.
- Mindenki pisztollyal és gépkarabéllyal éled újra. A pályán sörétes, rakétavető (középen a gerinc tetején) és mesterlövészpuska (a toronytetőkön) van.
- A sárga ugrópadok viszik fel a játékost a torony emeleteire. A toronytetőről a mellvéd résein át lehet leugrani.
- A botok szerepe: támadó, védő vagy portyázó. A sebzésük a játékosokénak 60%-a (`BOT_DAMAGE`).

Minden számszerű beállítás a `src/config.ts`-ben van. A pálya, a tárgyak, a spawnok és a botok útvonal-hálója a `src/game/mapgen.ts`-ben található.

## Felépítés

```
src/
  config.ts          balansz, konstansok
  net/               P2P link (Trystero), üzenettípusok
  game/world.ts      voxel-világ: chunk-mesh, raycast, ütközés, rombolás
  game/mapgen.ts     pálya, tárgyak, spawnok, bot-útvonalháló
  game/ctf.ts        zászló-szabályok (a host dönt)
  game/bot.ts        bot AI: A* útkeresés, szerepek, célzás
  game/entity.ts     a 8 játékos-hely
  game/game.ts       fő ciklus: lövés, rakéták, sebzés, halál, hálózat
  game/scenery.ts    űr-háttér: bolygó, aszteroidák, csillagok
  ui/                HUD, lobby
```
