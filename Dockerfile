FROM node:10
WORKDIR /app
COPY . /app/
EXPOSE 5984
ENV PGHOST 0.0.0.0
RUN npm install
CMD npm start