export const REGEX_STATION_DATA_TIME =
  /Latest readings recorded at (?<time>\d+:\d+) Hong Kong Time (?<date>\d+ .* \d{4})/;

export const REGEX_AQHI_CURRENT =
  /General Stations: ((?<generalOne>\d+\+?)|(?<generalMin>\d+) to (?<generalMax>\d+\+?)) \(Health Risk: [a-zA-Z ]+\)<\/p><p>Roadside Stations: ((?<roadOne>\d+\+?)|(?<roadMin>\d+) to (?<roadMax>\d+\+?)) \(Health Risk: [a-zA-Z ]+\)/;

export const REGEX_SPECIAL_WEATHER_TIPS_CONTENT =
  /((?<tip>[\s\S]+)\s*Updated at (?<time>\d+:\d+) HKT (?<date>\d+[.\-/]\d+[.\-/]\d+)\s*)|((?<tip2>[\s\S]+)\s*(?<date2>\d{4}年\d+月\d+日)(?<time2>\d+時\d+分).*\s*)/m;

export const FLICKR_DOWN = 'Sorry.  Background is not currently available.';
