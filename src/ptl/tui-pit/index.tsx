#!/usr/bin/env node
import { render } from "ink";
import React from "react";
import { PitApp } from "./app.js";

render(<PitApp />, { exitOnCtrlC: false });
