/**
 * District suggestions.
 *
 * `merchant.district` is a free-text `VarChar(80)` column, not an enum — the
 * API stores whatever the applicant types. That is deliberate: Hong Kong's
 * neighbourhood vocabulary changes faster than a migration cycle (a new
 * development gets a name, a mall becomes a landmark), and a hard enum would
 * mean a deploy every time somebody opens a shop somewhere new.
 *
 * The cost of free text is that `?district=` filtering only works when two
 * merchants spell the same place the same way. So the apply form offers a
 * `<select>` rather than an input: consistency on the way in is what makes the
 * filter work on the way out. These names are the ones customers actually use
 * when they search, grouped by region because a flat list of forty is a
 * scrolling exercise on a phone.
 *
 * The authoritative list of districts that have merchants is
 * `GET /v1/merchants/districts`, which the discovery page reads. This file is
 * only the picker.
 */

export interface DistrictGroup {
  /** Region label shown as an `<optgroup>`. */
  region: string;
  districts: string[];
}

export const HK_DISTRICT_GROUPS: DistrictGroup[] = [
  {
    region: '香港島',
    districts: [
      'Central',
      'Admiralty',
      'Sheung Wan',
      'Sai Ying Pun',
      'Kennedy Town',
      'Wan Chai',
      'Causeway Bay',
      'Happy Valley',
      'North Point',
      'Quarry Bay',
      'Tai Koo',
      'Chai Wan',
      'Aberdeen',
      'Stanley',
    ],
  },
  {
    region: '九龍',
    districts: [
      'Tsim Sha Tsui',
      'Jordan',
      'Yau Ma Tei',
      'Mong Kok',
      'Tai Kok Tsui',
      'Sham Shui Po',
      'Cheung Sha Wan',
      'Lai Chi Kok',
      'Kowloon City',
      'To Kwa Wan',
      'Hung Hom',
      'Wong Tai Sin',
      'San Po Kong',
      'Kowloon Bay',
      'Ngau Tau Kok',
      'Kwun Tong',
      'Lam Tin',
      'Tseung Kwan O',
    ],
  },
  {
    region: '新界',
    districts: [
      'Kwai Chung',
      'Tsuen Wan',
      'Tuen Mun',
      'Yuen Long',
      'Tin Shui Wai',
      'Tai Po',
      'Sha Tin',
      'Ma On Shan',
      'Sai Kung',
      'Sheung Shui',
      'Fanling',
    ],
  },
  {
    region: '離島',
    districts: ['Tung Chung', 'Discovery Bay', 'Cheung Chau', 'Lamma Island'],
  },
];

/** Flat list, for a plain `<select>` or a filter chip row. */
export const HK_DISTRICTS: string[] = HK_DISTRICT_GROUPS.flatMap((group) => group.districts);
