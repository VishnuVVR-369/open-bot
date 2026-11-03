/* global http, output, json, FIXTURE_URL, APPROVAL */
output.decision = json(http.post(FIXTURE_URL + "/decide/" + APPROVAL, { body: "{}" }).body);
