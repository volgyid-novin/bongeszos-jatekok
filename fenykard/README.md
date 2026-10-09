# FÉNYKARD

Fénykardpárbaj 1v1 a böngészőben. **A telefonod a kard markolata**: a giroszkópja forgatja a pengét a monitoron. Egyedül a gyakorló robot ellen játszhatsz, vagy egy barátod ellen, akinek szintén van gépe és telefonja.

Játékszerver nincs: a gépek és a telefonok közvetlenül kapcsolódnak egymáshoz (WebRTC, Trystero/Nostr), ugyanúgy, mint a többi játékban.

## Indítás

A projekt gyökérmappájából (`D:\izsi\lol`):

```bash
npm install
npm run dev
```

Utána nyisd meg: http://localhost:5173/fenykard/

A gépen localhoston minden megy, de **a telefonnak HTTPS kell** (különben a böngésző nem adja ki a mozgásérzékelőt, és a kapcsolat sem jön létre). Saját gépről a gyors út egy Cloudflare quick tunnel:

```bash
npx cloudflared tunnel --url http://localhost:5173
```

A gépen is a kiírt `https://….trycloudflare.com/fenykard/` címet nyisd meg (ne a localhostot), mert a QR-kód arra a címre mutat, ahol a játékot megnyitottad.

Online: **https://volgyid-novin.github.io/bongeszos-jatekok/fenykard/**

## A telefon párosítása

1. A gépen megnyitod a játékot. A menüben ott a QR-kód.
2. Beolvasod a telefon kamerájával. A telefonon megnyílik a kontroller, rajta a **KARD BE** gomb. Megnyomod (iPhone-on itt kér engedélyt a mozgásérzékelőhöz).
3. A gépen kiírja: **A kard él**, és a menü háttere átvált: a kardod már követi a telefont, lehet suhintani.
4. Fogd a telefont úgy, mint egy távirányítót: **a teteje a penge**, a képernyője felfelé néz. Ha elcsúszik az irány, fogd a monitor felé, és **tartsd nyomva az IGAZÍTÁS gombot** (fél másodperc, hogy egy véletlen érintés suhintás közben ne igazítson).

Minden géphez külön QR-kód tartozik (hosszú, véletlen kód), így a telefonod nem tud véletlenül a barátod gépéhez csatlakozni. Ha a telefon elalszik vagy újratöltöd, elég újra megnyitni ugyanazt a lapot: a gép újratöltés után is ugyanazt a kódot használja. Ha meccs közben kiesik a telefon, a kör szünetel, amíg vissza nem jön.

Telefon nélkül az egér mozgatja a kardot (kipróbálni jó, játszani a telefonnal az igazi).

## Játék egy barátoddal

Mindketten párosítjátok a saját telefonotokat a saját gépetekkel. Utána az egyikőtök **ÚJ SZOBA**-t nyom, és elküldi a meghívó linket. Aki megnyitja, annak a kód már be van írva, csak a **BELÉPÉS** gombot kell megnyomnia. Ha mindketten **KÉSZ**-t nyomtok (a gépen vagy a telefonon), indul a párbaj.

Akkor megy a legjobban, ha a telefon és a gép ugyanazon a wifin van: így a kard adatai a helyi hálón mennek a géphez, pár ms késéssel.

## Szabályok

- Mindkét félnek 100 életereje van. Aki elsőként nyer **2 kört**, megnyeri a meccset.
- Csak a **suhintás** sebez: a penge hegyének legalább ~2,6 m/s-mal kell mozognia. A fej 30, a törzs 20, a láb 12 sebzés, gyorsabb suhintásnál többet sebez (legfeljebb másfélszeresét).
- **Hárítás**: ha a két penge összeér, szikrázik, és egy pillanatig egyik sem sebez. A kardod ilyenkor kicsit lepattan a képernyőn, a telefon rezeg (Androidon; iPhone-on a böngésző nem tud rezegni).
- Találat után a találatot kapó fél fél másodpercig nem sebezhető.
- **W / S**: előre, hátra (S-sel ki lehet lépni a penge hatótávjából), **A / D**: oldalazás körbe. Nem kötelező, billentyű nélkül is a jó távolságban maradsz.

## Hogyan működik

- **Giroszkóp → kard**: a telefon `deviceorientation` eseményeiből (alfa, béta, gamma) kvaterniót számol, és a gép felé küldi kb. 60-szor másodpercenként. Csak az elfordulás van meg, a telefon helyzete nincs (a gyorsulásmérőből pár másodperc alatt elszállna), ezért a kéz a mellkas előtt van rögzítve, és csak kicsit mozdul a penge irányába. Az igazítás csak a vízszintes irányt (az elcsúszó „merre néz”) állítja vissza, a dőlést a gravitáció adja, az nem csúszik el.
- **Hálózat**: két fajta szoba van. A *kard-szoba* (`kard-<kód>`) csak a gépet és a saját telefonját köti össze, a *párbaj-szoba* (`duel-<KÓD>`) a két gépet. Mindegyik gép a saját harcosát mozgatja, és elküldi a másiknak (helyzet, kard, suhintási sebesség).
- **Bíró**: a házigazda gépe dönti el a kardcsapásokat és a találatokat. Két képkocka között végigsöpri mindkét pengét (4 részlépésben), így egy gyors suhintás sem csúszhat át a másik pengén vagy a testen. Előbb a penge–penge érintkezést nézi, csak utána a testet. Minden eseményt (kardcsapás, találat, kör, győzelem) elküld a másik gépnek, és mindkét gép ugyanúgy alkalmazza.
- **Gyakorló robot**: ugyanúgy kardot forgat, mint egy játékos: kitart, látható lendületet vesz és vág, és (nem mindig) a pengéje elé teszi a sajátját.

## Felépítés

```
fenykard/
  index.html   a menük, a HUD és a telefonos kontroller felülete, stílus
  main.js      eldönti, melyik szerep: ?kard=… → kontroller, különben a játék
  pad.js       a telefon: giroszkóp → kvaternió, igazítás, küldés a gépnek
  pc.js        a gép: QR-párosítás, szoba, menük, a meccs és a körök
  fight.js     szabályok és geometria: harcos, mozgás, bíró, gyakorló robot
  view.js      three.js jelenet: aréna, harcosok (IK karok), pengék, csík, szikrák, bloom
  audio.js     szintetizált hangok: zúgás, suhintás, kardcsapás, találat
  net.js       P2P szobák (Trystero)
```

A számok (penge hossza, sebzések, sebességküszöb, körök száma) a `fight.js` elején vannak.
