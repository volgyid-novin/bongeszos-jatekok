# PAJZSUGRÁS

UT2004 hangulatú trükkugrós időfutam a böngészőben. Nyolc pálya a kiképzéstől a mesterig, saját mozgásmotorral: dupla ugrás, kiugrás, falról kiugrás, strafe ugrás, és mindenekelőtt a **pajzsugrás**, vagyis a pajzslöket, amivel a saját ugrásodat tolod meg. Nincs lövöldözés és nincsenek botok: te vagy az óra ellen, a saját rekordod szelleme ellen, vagy haverokkal egy szobában ugyanazon a pályán.

Játékszerver nincs: a szobában a böngészők közvetlenül kapcsolódnak egymáshoz (WebRTC, Trystero/Nostr), a globális ranglista pedig nyilvános Nostr relékre épül.

## Indítás

A projekt gyökérmappájából (`D:\izsi\lol`):

```bash
npm install
npm run dev
```

Utána nyisd meg: http://localhost:5173/pajzsugras/ (vagy a `.claude/launch.json` `pajzsugras` bejegyzésével, ami az 5215-ös porton indítja). Chrome, Edge vagy Firefox kell hozzá az egér befogása miatt.

Állandó online link: **https://volgyid-novin.github.io/bongeszos-jatekok/pajzsugras/**

## Irányítás

| Billentyű | Mit csinál |
|---|---|
| W A S D | mozgás |
| Egér | körbenézés (az egér befogódik, a nyers mozgást használja, ahol a böngésző engedi) |
| Space | ugrás, a levegőben dupla ugrás |
| 2× koppintás W / A / S / D | kiugrás az adott irányba |
| Shift | nincs funkciója: sprint nincs, mindig teljes sebességgel futsz, mint a UT2004-ben |
| Bal egérgomb nyomva | pajzs töltése (kb. 1,2 mp alatt tele), elengedéskor lökés |
| R | vissza az utolsó ellenőrzőpontra |
| Enter | a pálya újrakezdése |
| Tab | eredménytábla (szobában) |
| Esc | szünet menü |

Az óra az **első gombnyomásra** indul. Ha leesel, lávába vagy lézerbe lépsz, azonnal visszakerülsz az utolsó ellenőrzőpontra, az idő közben is megy.

## Technikák

- **Dupla ugrás**: a levegőben még egyszer Space. Levegőnként egyszer megy, földetéréskor újra megvan. A csúcson a leghatásosabb.
- **Kiugrás**: dupla koppintás egy irányra. Gyors, alacsony ugrás, 13,2 m/s. Földetérés után kb. 0,35 mp-et várni kell a következőre.
- **Kiugró ugrás**: kiugrás, majd a levegőben dupla ugrás. Ez viszi a legmesszebbre (kb. 14 m).
- **Falról kiugrás**: a levegőben, fal közelében (fél méteren belül) kiugrás. Légterenként egyszer megy, utána a dupla ugrás még megvan.
- **Felvonós ugrás**: mozgó padlóról elugorva a padló sebessége hozzáadódik az ugrásodhoz.
- **Pajzsugrás**: nézz lefelé, tartsd a bal gombot, majd Space és a gomb elengedése egyszerre (a sorrend mindegy, ha 80 ms-on belül van). A lökés a töltéstől függ: rövid kattintás kb. 2,3 m, teljes töltés kb. 6,5 m magas ugrást ad. A pajzs 2,4 m-en belüli felületre hat.
- **Pajzs + dupla ugrás**: a pajzsugrás csúcsán még egy dupla ugrás, kb. 8 m magasra visz.
- **Fali lökés**: a levegőben töltött pajzzsal egy közeli falra lőve a lökés elfelé visz a faltól.
- **Pajzs-strafe**: futás közben ferdén lefelé lőve vízszintes sebességet kapsz, és a strafe-gyorsulás ráadódik (kb. 21 m-es ugrás is kijön).
- **Strafe ugrás**: tartsd a Space-t, váltogasd az A és D gombot W mellett, és az egeret húzd mindig a kanyar irányába. A sebességed 8,8 m/s fölé nő, egy jó játékos 13–15 m/s-ig.
- **Bunnyhop**: ha földetéréskor azonnal újra ugrasz, nem veszítesz sebességet. A beállításokban az automatikus ugrással elég tartani a Space-t.
- **Ugrópárna**: rálépsz, és a célig repít. A levegőben irányíthatod magad.

A KIKÉPZÉS pálya minden technikához tanít egy állomást, hologram táblával és padlójelekkel.

## Pályák

| # | Pálya | Nehézség | Mit tanít / mit kér |
|---|---|---|---|
| 1 | KIKÉPZÉS | Kiképzés | egy állomás minden technikához, bő tűréssel |
| 2 | ÖNTÖDE | Könnyű | rozsdás öntöde, dupla ugrás, felvonók, rövid kiugrások |
| 3 | ÉGI KIKÖTŐ | Könnyű | lebegő szigetek, ugrópárnák, kiugró ugrás, pajzsugrás jelzett helyeken |
| 4 | KRISTÁLYAKNA | Közepes | falról kiugrós aknák, kiugró ugrások, pajzsos rövidítés |
| 5 | NEONTORONY | Közepes | pajzsugrásos mászás, teljes töltés, fali lökés, strafe-os rövidítés |
| 6 | LÁVATEMPLOM | Nehéz | hosszú szakadékok, kiugró ugrás, strafe, pajzs-strafe |
| 7 | VIHARGÁT | Nehéz | mozgó szerkezetek, fali lökés, falugrás-láncok |
| 8 | ORBITÁLIS | Mester | űrállomás, teljes kombinációk: pajzsugrás, falról kiugrás, dupla ugrás, strafe-láncok |

Mind elérhető az elejétől, nincs zárolás. A nehezebb pályákon a rések a technikák határához közelebb vannak (Könnyű kb. 60%, Közepes 75%, Nehéz 85–90%, Mester 92–95%), és vannak ügyes játékosnak szánt rövidítések. Minden pálya végigmenetét a gép bizonyítja: a tesztek lejátszanak egy pontos útvonalat minden pályán, abból jön az **idő a szerzőtől**.

### Érmek

Pályánként négy érem van, a szerzői idő (A) szorzóival: **Szerző** (megdöntöd A-t), **Arany** (1,15 × A), **Ezüst** (1,4 × A), **Bronz** (1,9 × A). A játék közben a HUD mindig a következő megszerezhető érem idejét mutatja.

## Saját rekord és szellem

Minden pályához a böngésződben tárolódik a legjobb idő, a részidők és a futás felvétele. A következő futásnál az **áttetsző szellem** mutatja a rekordodat, és minden ellenőrzőpontnál zöld (gyorsabb) vagy piros (lassabb) különbség jelenik meg. A szellem a beállításokban kikapcsolható. A rekordok a `pajzsugras:*` localStorage kulcsokban vannak; ha egy pálya geometriája megváltozik, a régi rekord eltűnik (a pálya ujjlenyomata más lesz), így nem lehet régi idővel összehasonlítani.

## Beállítások

Név (legfeljebb 16 karakter), egér érzékenység, látómező (alapérték 100° vízszintesen), automatikus ugrás, billentyű-kijelző (Defrag stílus), szellem, grafika, hangerő.

Grafika szintek:

- **Alacsony**: nincs utófeldolgozás, 1× felbontás, nincs árnyék, kisebb textúrák. Gyenge gépekre.
- **Közepes** (alap): fényvirág (bloom), élsimítás, 1024-es árnyéktérkép a játékos körül.
- **Magas**: 4× MSAA, nagy felbontás, 2048-as árnyéktérkép, 16× anizotróp szűrés.

## Szoba (többjátékos)

Egy szobában legfeljebb 8 játékos fut ugyanazon a pályán. A játékosok áttetsző szellemként látják egymást, nincs ütközés.

1. Főmenü, **SZOBA**, **ÚJ SZOBA**: egy 4 betűs kód jön létre, és egy meghívó link (`…/pajzsugras/#KÓD`) a másolás gombbal.
2. A haver megnyitja a linket (vagy beírja a kódot) és belép. A szoba létrehozója a házigazda; aki később csatlakozik, nem veszi át a szerepet. Ha a házigazda kilép, a futam résztvevői közül a legkisebb azonosítójú folytatja.
3. Amíg a futam nem indul, mindenki szabadon gyakorolhat. A házigazda választ pályát és indít. Aki futam közben érkezik, nézőként vár, és a következő bemelegítésnél kerül a listára.
4. Visszaszámlálás, mindenki a rajthoz kerül, élő állás az ellenőrzőpontok alapján.
5. A futam akkor ér véget, ha mindenki célba ért, vagy az első cél után 60 másodperccel. Pontok: 10–8–6–5–4–3–2–1, a szoba összesítése a munkamenet végéig gyűlik.

**Ismert hiba (prototípus):** ritkán, lassú kapcsolatnál vagy ha ketten egyszerre lépnek be egy üres szobába, két házigazda alakulhat ki, és ha az üzeneteik keresztezik egymást, mindkettő átadhatja a szerepet a másiknak. Ilyenkor senki nem tud futamot indítani, amíg egyikük ki nem lép és vissza nem jön. Egy rosszindulatú játékos egy hamis üzenettel átveheti a házigazda szerepét. A tervezett javítás: a létrehozó marad a házigazda, a belépő sosem nevezi ki magát, helyette egy „Átveszem a szobát” gomb.

Az oldalt **HTTPS-en** (vagy localhoston) kell megnyitni, különben a szoba nem tud kapcsolódni. A hálózati beállítás ugyanaz, mint a többi játéknál: lásd a gyökér [README.md](../README.md) „Játék a haveroddal” részét.

## Ranglista (globális)

A **RANGLISTA** pályánként a legjobb 50 időt mutatja, a sajátod helyezésével. Szerver nincs: minden böngésző egyszer generál egy kulcsot (a böngészőben marad), és minden **új saját rekordot** aláírt Nostr eseményként tesz közzé néhány nyilvános reléen. A lista ugyanezekről a relékről töltődik be.

- A **nevek és idők nyilvánosak**, aki a relét nézi, látja őket.
- Az esemény a pálya ujjlenyomatához kötött, ezért ha egy pályát átterveznek, a régi idők eltűnnek.
- Értelmetlenül gyors időket a program eldob (a szerzői idő fele alatt nincs rekord, és a szobában sem számít a célba érkezés).
- Ha a relék nem érhetők el, a játék ezt kiírja, a helyi rekordok attól még mentődnek.

## Fejlesztőknek

```bash
npm run test:pj            # mozgás- és ütközésvizsgálat, technika-mérések, minden pálya bizonyító végigmenete
npm run test:pj -- --map=kikepzes -v
```

A böngészőben a `window.__pj` hibakereső felület használható (akkor is, ha a böngészőablak rejtett, mert a requestAnimationFrame ilyenkor nem fut):

```js
await __pj.loadMap('kikepzes')            // pálya betöltése, kézi léptetés
__pj.setInput({ fwd: 1, jump: true })     // billentyűk (pitchDeg / yawDeg fokban)
__pj.advance(1.5)                         // 1,5 mp szimuláció és egy kép kirajzolása
__pj.teleport([0, 0, -20], 90)            // játékos áthelyezése
await __pj.runRoute('kikepzes')           // a bizonyító útvonal lejátszása (csak hibakereséshez)
__pj.state()                              // állapot: hely, sebesség, óra, ellenőrzőpont, rajzolási szám
await __pj.quality('magas')               // grafika szint
__pj.screen('results')                    // képernyők: menu, play, settings, controls, pause, results
```

Felépítés:

```
sim/        a szimuláció (nincs benne three, DOM, Date): ütközés, mozgás, pajzs, pályaépítő (builder.js), bizonyító bot
maps/       a 8 pálya adatként (builder DSL), index.js a lista
render/     three.js: textúrák, pálya, ég, díszletek, figurák, pajzsfegyver, effektek
main.js     indítás, 120 Hz-es ciklus, a futás menete, az `app` felület a szoba és a ranglista számára
ui.js hud.js input.js audio.js store.js    menük, HUD, bemenet, hang, mentés
race.js leaderboard.js                      szoba és ranglista
test/       a node-os tesztek
```

Új pálya: a `maps/kikepzes.js` a mintapélda, a pályaépítő nyelv leírása a `sim/builder.js` fejlécében van, a bizonyító bot lépései a `sim/bot.js` fejlécében. Minden új pályának végig kell mennie a `npm run test:pj` ellenőrzésén.
