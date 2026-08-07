#!/usr/bin/env node
import { render } from "ink";
import React from "react";
import { PtlApp } from "./app.js";

render(<PtlApp />, { exitOnCtrlC: false });
