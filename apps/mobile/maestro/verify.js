/* global http, output, json, FIXTURE_URL */
output.state = json(http.get(FIXTURE_URL + "/state").body);
