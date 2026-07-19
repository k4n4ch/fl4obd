# FL4 OBD 対応PID一覧

自力調査による Honda FL4 (Civic e:HEV) の OBD-II 対応PID。

## ECUアドレス

| TA | CAN ID (物理) | 推定役割 |
|----|--------------|---------|
| 01 | 18DAF101 | HV バッテリー ECU |
| 02 | 18DAF102 | — |
| 06 | 18DAF106 | — |
| 07 | 18DAF107 | エンジン ECU |
| 10 | 18DAF110 | — |
| EF | 18DAF1EF | (ブロードキャスト相当) |

---

## PID 対応表

| PID | 01 | 02 | 06 | 07 | 10 | EF | 単位 | 変換式 | 説明 |
|:---:|:--:|:--:|:--:|:--:|:--:|:--:|:----:|--------|------|
| 01 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | Monitor status since DTCs cleared |
| 03 |   |   |   |   | ✓ |   | — | — | Fuel system status |
| 04 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | % | 100A/255 | Calculated engine load |
| 05 | ✓ | ✓ | ✓ |   |   |   | ℃ | A−40 | Engine coolant temperature |
| 06 |   |   |   |   | ✓ |   | % | A/128−100 | Short term fuel trim — Bank 1 |
| 07 |   |   |   |   | ✓ |   | % | A/128−100 | Long term fuel trim — Bank 1 |
| 0B |   |   |   |   | ✓ |   | kPa | A | Intake manifold absolute pressure |
| 0C | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | rpm | (256A+B)/4 | Engine speed |
| 0D | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | km/h | A | Vehicle speed |
| 0E |   |   |   |   | ✓ |   | deg | A/2−64 | Timing advance |
| 11 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | % | 100A/255 | Throttle position |
| 13 |   |   |   |   | ✓ |   | — | — | Oxygen sensors present |
| 15 |   |   |   |   | ✓ |   | V/% | A×0.005 / B/128−100 | Oxygen Sensor 2 (voltage / STFT) |
| 1C | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | OBD standards this vehicle conforms to |
| 1F | ✓ | ✓ | ✓ | ✓ | ✓ |   | sec | 256A+B | Run time since engine start |
| 20 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | PIDs supported [$21–$40] |
| 21 | ✓ | ✓ | ✓ | ✓ | ✓ |   | km | 256A+B | Distance traveled with MIL on |
| 23 |   |   |   |   | ✓ |   | kPa | 10(256A+B) | Fuel Rail Gauge Pressure |
| 2C |   |   |   |   | ✓ |   | % | 100A/255 | Commanded EGR |
| 2D |   |   |   |   | ✓ |   | % | A/128−100 | EGR Error |
| 2E |   |   |   |   | ✓ |   | % | 100A/255 | Commanded evaporative purge |
| 2F |   |   |   |   | ✓ |   | % | 100A/255 | Fuel Tank Level Input |
| 30 |   |   |   | ✓ |   |   | — | A | Warm-ups since codes cleared |
| 31 | ✓ | ✓ | ✓ | ✓ | ✓ |   | km | 256A+B | Distance traveled since codes cleared |
| 33 |   |   |   |   | ✓ |   | kPa | A | Absolute Barometric Pressure |
| 34 |   |   |   |   | ✓ |   | —/A | — | Oxygen Sensor 1 (λ ratio / current) |
| 3C |   |   |   |   | ✓ |   | ℃ | (256A+B)/10−40 | Catalyst Temperature: Bank 1, Sensor 1 |
| 40 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | PIDs supported [$41–$60] |
| 41 | ✓ | ✓ | ✓ |   |   |   | — | — | Monitor status this drive cycle |
| 42 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | V | (256A+B)/1000 | Control module voltage (12V系) |
| 43 |   |   |   |   | ✓ |   | % | 100(256A+B)/255 | Absolute load value |
| 44 |   |   |   |   | ✓ |   | ratio | 2(256A+B)/65536 | Commanded Air-Fuel Equivalence Ratio (λ) |
| 47 |   |   |   |   | ✓ |   | % | 100A/255 | Absolute throttle position B |
| 49 |   |   |   | ✓ |   |   | % | 100A/255 | Accelerator pedal position D |
| 4A |   |   |   | ✓ |   |   | % | 100A/255 | Accelerator pedal position E |
| 51 |   |   |   |   | ✓ |   | — | — | Fuel Type |
| 55 |   |   |   |   | ✓ |   | % | — | Short term secondary O2 sensor trim |
| 56 |   |   |   |   | ✓ |   | % | — | Long term secondary O2 sensor trim |
| 5B | ✓ |   |   | ✓ | ✓ |   | % | 100A/255 | Hybrid battery pack remaining life (SOC) |
| 60 | ✓ |   |   | ✓ | ✓ | ✓ | — | — | PIDs supported [$61–$80] |
| 66 |   |   |   |   | ✓ |   | g/s | — | Mass air flow sensor |
| 67 |   |   |   | ✓ | ✓ | ✓ | ℃ | B−40 / C−40 | Engine coolant temperature (multi-sensor) |
| 68 |   |   |   |   | ✓ |   | ℃ | B−40 / C−40 | Intake air temperature sensor |
| 6C |   |   |   |   | ✓ |   | — | — | Commanded throttle actuator control |
| 80 | ✓ |   |   |   | ✓ |   | — | — | PIDs supported [$81–$A0] |
| 9A | ✓ |   |   |   |   |   | V/A | V=(256C+D)/64, I=signed16(256E+F)×0.1 | Hybrid/EV battery voltage & current |
| 9F |   |   |   |   | ✓ |   | — | — | (未解析) |

---

## 備考

- **PID 0x9A はTA=01専用**。他のECUでは応答なし。マルチフレーム(ISO 15765-2)で返る。
- **TA=10 (18DAF110) は独自PIDが多い**。0x2F(燃料残量)・0x3C(触媒温度)・0x67(冷却水温)など、TA=01ポーリング時には取れないため別途ヘッダー切替が必要。
- **PID 0x1F (ランタイム) はTA=01で取得**。起動時に1回のみ送信。
- PID分類ビットマップはService 01 PID 00/20/40/60/80 の応答を各ECUに対してデコードして作成。
