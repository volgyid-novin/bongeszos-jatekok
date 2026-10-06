# HADÚR

Valós idejű stratégiai játék (RTS) a böngészőben, a régi Warcraft és StarCraft hangulatában: **emberek az orkok ellen**, 1v1. Bányássz aranyat, vágj fát, építsd fel a bázisodat, képezz sereget, és rombold le az ellenfél összes épületét.

Egyedül a gép ellen játszhatsz (három nehézség), vagy egy barátod ellen. Játékszerver nincs: a két böngésző közvetlenül kapcsolódik egymáshoz (WebRTC, Trystero/Nostr), ugyanúgy, mint a BLOCKSHOT-ban és a HOMOKFUTAM-ban.

## Indítás

A projekt gyökérmappájából (`D:\izsi\lol`):

```bash
npm install
npm run dev
```

Utána nyisd meg: http://localhost:5173/hadur/

## Játék egy barátoddal

Online: **https://volgyid-novin.github.io/bongeszos-jatekok/hadur/**. Írd be a neved, válassz népet, nyomj **ÚJ SZOBA**-t, és küldd el a meghívó linket. Aki megnyitja, annak a kód már be van írva, csak a **BELÉPÉS** gombot kell megnyomnia. Ha mindketten **KÉSZ**-t nyomtok, indul a csata. A házigazda a kék, a vendég a piros.

Saját gépről futtatva az oldalt **HTTPS-en** (vagy localhoston) kell megnyitni, különben a szoba nem tud kapcsolódni. A gyors út ugyanaz, mint a többi játéknál:

```bash
npm run build
npm run preview
```

```bash
npx cloudflared tunnel --url http://localhost:4173
```

A kiírt `https://….trycloudflare.com/hadur/` linket nyisd meg (ne a localhostot).

## Irányítás

Egér és billentyűzet kell hozzá, telefonon nem játszható.

| Mit | Hogyan |
|---|---|
| Kijelölés | bal klikk, vagy egérhúzás (keretbe csak a saját egységek kerülnek) |
| Az összes ilyen egység a képernyőn | dupla klikk vagy Ctrl + klikk |
| Hozzáadás / elvétel | Shift + klikk |
| Parancs | jobb klikk: mozgás, támadás, bányászat, favágás, építés folytatása, rakomány leadása |
| Gyülekezőpont | épületet kijelölve jobb klikk (bányára vagy fára téve az új munkások egyből dolgoznak) |
| Parancsgombok | a jobb alsó 3×4-es rács: **Q W E R / A S D F / Z X C V** |
| Támadó menet | **A**, majd klikk a földre: útközben mindenkit megtámadnak |
| Állj / tartsd a helyed | **S** / **W** (vagy **H**) |
| Építés | munkással **C** (vagy **B**), majd az épület gombja, végül a helye. Shift-tel több is lerakható |
| Kiképzés | épületen a gomb; Shift-tel egyszerre ötöt sorba állít |
| Csapatok | **Ctrl + 1–9** mentés, **1–9** előhívás, kétszer gyorsan: oda ugrik a kamera |
| Kamera | nyilak, a képernyő széle, középső gombos húzás, görgő: zoom, minitérkép |
| Ugrás a támadáshoz | **Szóköz** |
| Menü / szünet | **Esc** vagy **F10** (többjátékos módban a csata nem áll meg) |

## A két nép

Mindkét népnek 6 épülete és 6 egysége van. Az egységek szerepe páronként megfelel egymásnak, de a számok és a különleges támadások eltérnek.

| Emberek | Orkok | Mire jó |
|---|---|---|
| Városháza | Nagyterem | főépület: munkást képez, ide hordják a nyersanyagot, 6 élelem |
| Tanya | Disznóól | 8 élelem |
| Kaszárnya | Barakk | közelharcos, távolsági, lovas egység |
| Kovácsműhely | Fegyverkovács | ostromgép, fegyver- és páncélfejlesztés (2-2 szint) |
| Őrtorony | Őrbástya | védőtorony |
| Mágustorony | Szellemkunyhó | varázsló |

| Emberek | Orkok | |
|---|---|---|
| Paraszt | Peon | munkás |
| Gyalogos | Morgó | közelharcos (a morgónak több az életereje, a gyalogosnak a páncélja) |
| Íjász | Fejszevető | távolsági |
| Lovag | Farkaslovas | gyors, erős lovas; kell hozzá kovácsműhely / fegyverkovács |
| Mágus | Sámán | tűzgolyó területre / láncvillám, ami még két ellenségre átugrik |
| Ballista | Katapult | ostromgép, épületek ellen másfélszeres sebzés; a katapult területre sebez |

## Szabályok

- Kezdéskor van egy főépületed és 4 munkásod, akik már bányásznak. 400 arany és 200 fa a kezdőtőke.
- Egy forduló 10 arany vagy 10 fa. A bánya kimerül (a fő bányákban 9000 arany van), ilyenkor a munkások a legközelebbi másik bányához mennek. A pályán 6 bánya van: a két bázisé, kettő a bázisok előtt és kettő a másik két sarokban. Új főépülettel lehet terjeszkedni.
- Az élelem korlátozza a sereget: minden egység élelmet fogyaszt, a tanyák / disznóólak adnak. A felső határ 100.
- Aki elveszti az összes épületét, veszít. Feladni a menüből lehet.
- A köd mindent eltakar, amit az egységeid és épületeid nem látnak. A felfedezett, de nem látott területen az ellenség egységei nem látszanak.

## Hogyan működik a hálózat

Determinisztikus lockstep, ahogy a régi RTS-ek csinálták: a gépek csak a parancsokat küldik át, és mindkettő ugyanazt a szimulációt futtatja. A szimuláció 10 ütemet számol másodpercenként, egy parancs 3 ütemmel később hajtódik végre mindkét gépen (kb. 0,3 mp késés). Ha az egyik gép lemarad, a másik megvárja („Várakozás az ellenfélre…”). 5 másodpercenként a két gép összeveti az állapot ellenőrzőösszegét; ha eltérne, a képernyő tetején szól.

Ezért a `sim.js`-ben nincs `Math.random`, `sin`, `cos`, `atan2`: csak olyan műveletek, amik minden böngészőben bitre ugyanazt adják.

## Felépítés

```
hadur/
  index.html   menük, HUD, stílus
  data.js      a két nép: épületek, egységek, fejlesztések, költségek
  sim.js       determinisztikus szimuláció: pálya, útkeresés (A*), gyűjtés, építés, harc
  ai.js        a gépi ellenfél
  models.js    a 3D modellek (alapformákból összerakva)
  view.js      three.js jelenet: terep, erdő, köd, egységek, lövedékek, részecskék
  audio.js     szintetizált hangok
  net.js       P2P szoba (Trystero)
  main.js      lockstep játékhurok, irányítás, HUD, minitérkép, menük
```

A balansz a `data.js`-ben van (minden egység és épület költsége, életereje, sebzése, hatótávja, építési ideje). A pálya elrendezése és a bányák a `sim.js` `layout()` és `genMap()` függvényében.
