# Suffer Sathi

ट्रेन के सफ़र का साथी: एक Android app जो phone के GPS से आपका सफ़र देखता है और रास्ते के हर station का समय अपने आप लिखता जाता है — ट्रेन कहाँ रुकी, कितनी देर रुकी और कौन-सा station बिना रुके निकल गया।

App बिना internet के चलता है: station और रास्तों का data APK के अंदर ही है। Internet सिर्फ़ नया version देखने के लिए लगता है।

## Install

सबसे नया signed APK हमेशा यहाँ मिलता है:

**[Suffer Sathi का नया version download करें](https://github.com/rohitrot738/rohitrot738/releases/tag/suffer-sathi-updates)**

Release के नोट में जिस file का नाम लिखा है (`Suffer-Sathi-<version>.apk`), वही install करें। एक बार install होने के बाद app खुद नया version बताता है और अपने अंदर से ही download और install करवा देता है; Android हर बार आपसे पुष्टि माँगता है।

## क्या-क्या करता है

- **सफ़र का log:** हर station पर "Ruka" (आने और जाने का समय, कितनी देर) या "Paar kiya" (किस समय निकला)। रुकने वाली entry पीली और बिना रुके निकलने वाली हरी दिखती है।
- **रास्ते में रुकना:** ट्रेन station के बाहर 30 सेकंड या ज़्यादा रुके तो वह भी समय के साथ लिखा जाता है, सबसे नज़दीकी station के नाम से।
- **Route चुनना:** शुरू और अंतिम station, और चाहें तो बीच के 3 तक "via" station। Station नाम या code से ढूँढे जा सकते हैं; बदले हुए code (जैसे DDU, PRYJ) भी चलते हैं।
- **किसका log चाहिए:** route बनने के बाद उसके सारे station tick के साथ दिखते हैं। जिसका log नहीं चाहिए उसका tick हटा दें, और छूटा हुआ station जोड़ दें। "Save karein" के बाद यह चुनाव app बंद करने पर भी बना रहता है।
- **अगला station:** route पर हों तो route से, वरना चलने की दिशा से अंदाज़ा।
- **Speed:** गोल dial में, km/h में।
- **घड़ी:** तारीख़ और समय second के साथ; एक बटन से पूरी screen पर बड़ी घड़ी, जिसके साथ speed भी दिखती है। समय का रंग 10 रंगों में से चुना जा सकता है।
- **CSV:** पूरा log CSV file में निकाला जा सकता है।

## Screen बंद होने पर भी log चाहिए तो

Phone की ये तीन settings ज़रूरी हैं, वरना phone app को background में रोक देता है:

1. Location permission: **Allow all the time** (हमेशा अनुमति दें)।
2. Battery: Suffer Sathi के लिए **Unrestricted** (कोई पाबंदी नहीं)।
3. Notification: चालू। Tracking के दौरान "Station pass aur halt record ho rahe hain" वाली notification दिखती रहनी चाहिए।

## ध्यान रखें

- Route "सबसे छोटा रास्ता" होता है, आपकी ट्रेन का असली route नहीं। ट्रेन किसी और line से जाए तो via station दें; वरना app दिशा के अंदाज़े पर चला जाता है।
- Station की जगह और नाम खुले data से लिए गए हैं और कहीं-कहीं पुराने या थोड़े गलत हो सकते हैं, इसलिए log में भी गलती आ सकती है।
- यह रेलवे का आधिकारिक app नहीं है। इसमें timetable, ट्रेन की live स्थिति या ticket की कोई जानकारी नहीं है।

## Repository में क्या है

| जगह | क्या है |
| --- | --- |
| `safar/` | App की screen (`index.html`), उसके tests (`test.cjs`) और station व रास्तों का data |
| `android/` | Android app का ढाँचा (Capacitor) और app के अंदर से update करने वाला code |
| `irsd/osm/` | OpenStreetMap से station और track का data बनाने वाली scripts |
| `loader_pipeline.py`, `indian_railways_complete.db` | Station catalog का स्रोत data और उसे बनाने वाली script |
| `scripts/build_www.sh` | App की files को APK में जाने के लिए इकट्ठा करती है |
| `.github/workflows/` | APK बनाने, जाँचने और release करने के workflows |

## बनाना और जाँचना

```sh
node safar/test.cjs        # app के tests
sh scripts/build_www.sh    # web files को www/ में इकट्ठा करना
npm ci && npx cap sync android
cd android && ./gradlew assembleDebug testDebugUnitTest
```

`main` पर हर बदलाव के बाद GitHub Actions signed APK बनाता है, उसे emulator पर पुराने version के ऊपर install करके चलाता है, और पास होने पर update release में डाल देता है। Signing और update की पूरी जानकारी [`safar/README.md`](safar/README.md) में है।

## Data का श्रेय

- Station catalog: DataMeet से लिया गया (CC0)।
- Track और कई station: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL 1.0।
