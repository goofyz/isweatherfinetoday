export function flickrTagsByWeather(weather_condition) {
  const sun = ['sun', 'sunny'];
  const clearTags = ['clear', 'calm'];
  const cloud = ['cloudy', 'cloud', 'clouds', 'partlycloudy'];
  const rain = ['rain', 'storm', 'rainy', 'typhoon'];
  const fog = ['fog', 'foggy', 'haze', 'mist', 'misty'];
  const wind = ['wind', 'windy'];
  const moon = ['moon', 'star'];
  let tag;

  switch (String(weather_condition)) {
    case '50':
    case '90':
    case '91':
      tag = [...sun, ...clearTags];
      break;
    case '51':
    case '52':
      tag = [...sun, ...cloud];
      break;
    case '53':
    case '54':
      tag = [...sun, ...rain, ...clearTags, ...cloud];
      break;
    case '60':
    case '61':
      tag = [...rain, ...cloud];
      break;
    case '62':
    case '63':
    case '64':
      tag = [...rain, ...rain];
      break;
    case '65':
      tag = [...rain, ...cloud, 'lightning', 'thunder'];
      break;
    case '70':
    case '71':
    case '72':
    case '73':
    case '74':
    case '75':
      tag = [...clearTags, ...moon];
      break;
    case '76':
    case '77':
      tag = [...cloud, ...moon];
      break;
    case '80':
    case '81':
      tag = [...wind, ...clearTags];
      break;
    case '83':
    case '84':
    case '85':
      tag = fog;
      break;
    default:
      tag = [...cloud];
  }

  return tag;
}

export function flickrTagsByHour(hour) {
  const time_dusk = ['dusk', 'sunset', 'twilight'];
  const time_morning = ['morning', 'sunrise', 'twilight'];
  const time_day = ['day'];
  const time_night = ['night', 'evening'];

  let tag;
  const h = hour;
  tag = h >= 6 && h < 18 ? [...time_day] : [...time_night];
  if (h >= 6 && h <= 8) tag = [...tag, ...time_morning];
  else if (h >= 18 && h <= 19) tag = [...tag, ...time_dusk];
  return tag;
}
