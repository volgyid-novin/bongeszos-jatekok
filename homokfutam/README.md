# HOMOKFUTAM

3D podverseny a böngészőben, a régi podracer játékok hangulatában. A rajt egy arénában van, utána a pálya kimegy a sziklatűk közé, átmegy egy kanyonon és egy természetes sziklaív alatt, a végén pedig visszaér a tribünök elé.

Egyedül öt bot ellen versenyzel. Haverokkal 2–6 ember játszhat egy szobában, a maradék podokat botok vezetik. Játékszerver nincs: a böngészők közvetlenül kapcsolódnak egymáshoz (WebRTC, Trystero/Nostr), ugyanúgy, mint a BLOCKSHOT-ban.

## Indítás

A projekt gyökérmappájából (`D:\izsi\lol`):

```bash
npm install
npm run dev
```

Utána nyisd meg: http://localhost:5173/homokfutam/ (a BLOCKSHOT marad a http://localhost:5173 címen).

## Játék a haverokkal

A legegyszerűbb az állandó online link: **https://volgyid-novin.github.io/bongeszos-jatekok/homokfutam/**. Nyisd meg, írd be a neved, nyomj **ÚJ SZOBA**-t, és küldd el a meghívó linket.

Ha a saját gépedről akarod futtatni: az oldalt **HTTPS-en** (vagy localhoston) kell megnyitni, különben a szoba nem tud kapcsolódni.

**A) Gyorsan, regisztráció nélkül (Cloudflare quick tunnel)**

```bash
npm run build
npm run preview
```

Egy másik terminálban:

```bash
npx cloudflared tunnel --url http://localhost:4173
```

Nyisd meg a kiírt `https://….trycloudflare.com/homokfutam/` linket (ne a localhostot!), írd be a neved, nyomj **ÚJ SZOBA**-t, és küldd el a meghívó linket. Aki megnyitja, annak a kód már be van írva, csak a **BELÉPÉS** gombot kell megnyomnia.

**B) Állandó link (ingyenes fiók kell)**

`npm run build` után a `dist` mappát töltsd fel Netlifyra, GitHub Pagesre vagy Cloudflare Pagesre. A játék a `/homokfutam/` útvonalon lesz.

### Hogyan megy egy futam

- A szobában mindenki a **KÉSZ VAGYOK** gombot nyomja. Ha mindenki kész, a házigazda indítja a futamot.
- A köröket és a botok erősségét a házigazda állítja (a listában a „házigazda” jelzésű játékos).
- Egy futamon legfeljebb 6 ember indul. A színeket és a rajthelyeket a játék sorsolja.
- Futam közben az **Esc** nem állítja meg a versenyt, csak a menüt hozza fel, a többiek közben mennek tovább.
- Az eredmény akkor jelenik meg, ha minden ember célba ért, legkésőbb 25 másodperccel a te befutód után. Aki még úton van, becsült idővel szerepel.
- Utána **VISSZA A SZOBÁBA**, és jöhet a következő futam.
- Ha valaki kilép futam közben, a podja kiesik. Ha a házigazda lép ki, a botokat a következő játékos gépe veszi át, és a futam megy tovább.

## Irányítás

| Billentyű | Mit csinál |
|---|---|
| W / ↑ | gáz |
| S / ↓ | fék (álló helyzetből tolat) |
| A D / ← → | kormányzás |
| Shift / Space | boost (melegíti a hajtóműveket) |
| C | kamera váltása (3 nézet) |
| R | vissza a pályára |
| Esc / P | szünet (többjátékos módban csak menü) |
| M | hang ki/be |

Kontrollerrel is megy: bal kar a kormány, RT a gáz, LT a fék, X vagy RB a boost, Start a menü, Y a kamera. Telefonon a gáz automatikus, a gombok a képernyő alján vannak.

## Szabályok és tippek

- **Hő:** a boost gyorsít, de melegíti a hajtóműveket. Ha a csík megtelik, a pod túlmelegszik: 3 másodpercig nincs boost, és a végsebesség is kisebb.
- **Tökéletes rajt:** ha a gázt a „RAJT!” előtti utolsó fél másodpercben nyomod le, a pod lendülettel indul.
- **Pálya széle:** a homokon a pod lelassul, a sziklákba ütközni pedig sokba kerül. Az arénában és a kanyonban fal van, attól a pod visszapattan.
- A rekordidődet (pályahossz szerint) és a legjobb körödet a böngésző megjegyzi. Csak az egyéni futamok számítanak bele.

## Felépítés

```
homokfutam/
  index.html   menük, HUD, stílus
  main.js      pálya, podok, fizika, botok, verseny, hang, többjátékos logika
  net.js       P2P szoba (Trystero), üzenettípusok
```

A fontos számok a `main.js`-ben vannak:

- `CTRL`: a pálya kontrollpontjai méterben
- `TOP`: végsebesség (m/s)
- `SKILL`: a botok tempója nehézségi szintenként
- `A_LAT`: mennyire gyorsan veszik be a kanyarokat a botok
